import type { Telegraf } from "telegraf";
import { getClient } from "./rpcClient";
import { listAllTracked, updateLastBlock, type TrackedRow } from "./db";
import { getChain } from "../config/chains";
import { env } from "../config/env";
import { tryDecodeEvent } from "./eventCatalog";

/** Max individual event alerts sent per contract per polling round. */
const MAX_ALERTS_PER_POLL = 5;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Works out which block range to scan next for one tracked contract.
 *
 * Returns undefined when there is nothing new to scan. Kept pure and
 * exported so the off-by-one behaviour (which would either miss events or
 * re-send duplicates) is testable without a live RPC.
 */
export function computePollRange(args: {
  lastBlock: string | null;
  currentBlock: bigint;
  maxRange: bigint;
  initialLookback: bigint;
}): { fromBlock: bigint; toBlock: bigint } | undefined {
  const { lastBlock, currentBlock, maxRange, initialLookback } = args;

  // A recorded last_block was already scanned, so resume at the next block.
  // With no record, start a bounded lookback behind the chain head.
  const start = lastBlock !== null ? BigInt(lastBlock) + 1n : currentBlock - initialLookback;
  const fromBlock = start < 0n ? 0n : start;

  if (fromBlock > currentBlock) return undefined;

  const cappedEnd = fromBlock + maxRange - 1n;
  const toBlock = cappedEnd > currentBlock ? currentBlock : cappedEnd;
  return { fromBlock, toBlock };
}

async function pollOne(bot: Telegraf, row: TrackedRow, currentBlock: bigint): Promise<void> {
  const chain = getChain(row.chain);
  if (!chain) return;
  const client = getClient(row.chain);

  const range = computePollRange({
    lastBlock: row.last_block,
    currentBlock,
    maxRange: env.trackMaxBlockRange,
    initialLookback: env.trackInitialLookbackBlocks,
  });
  if (!range) return;
  const { fromBlock, toBlock } = range;

  try {
    const logs = await client.getLogs({
      address: row.address as `0x${string}`,
      fromBlock,
      toBlock,
    });

    // A busy bridge can emit hundreds of events inside one polling window.
    // Telegram throttles roughly a message per second per chat, so sending
    // them all would get the bot rate-limited and bury the user in noise.
    // Send a bounded number and summarise the rest.
    const shown = logs.slice(0, MAX_ALERTS_PER_POLL);
    const overflow = logs.length - shown.length;

    for (const log of shown) {
      const decoded = tryDecodeEvent(log);
      const txUrl = chain.explorerTxUrl(log.transactionHash ?? "");
      const addrUrl = chain.explorerAddressUrl(row.address);

      let body: string;
      if (decoded) {
        const argLines = Object.entries(decoded.args)
          .filter(([k]) => Number.isNaN(Number(k))) // drop numeric-index dupes viem adds
          .map(([k, v]) => `  ${escapeHtml(k)}: <code>${escapeHtml(String(v))}</code>`)
          .join("\n");
        body = `<b>${escapeHtml(decoded.eventName)}</b>\n${argLines}`;
      } else {
        body = "<b>Новое событие</b>\n  структуру разобрать не удалось, подробности в транзакции";
      }

      const label = row.label || row.protocol || "контракт моста";
      // Linked only when there is somewhere to link to. A chain the bot
      // discovered may have no explorer, and an href that is not a URL makes
      // Telegram refuse the whole alert - the one message that exists to be
      // delivered the moment it is written.
      const addressLine = addrUrl
        ? `<a href="${addrUrl}">${escapeHtml(row.address)}</a>`
        : `<code>${escapeHtml(row.address)}</code>`;
      const txLine = txUrl
        ? `<a href="${txUrl}">транзакция ↗</a> · блок ${log.blockNumber}`
        : `транзакция <code>${escapeHtml(log.transactionHash ?? "?")}</code> · блок ${log.blockNumber}`;
      const text =
        `🔔 <b>${escapeHtml(chain.label)}</b> — ${escapeHtml(label)}\n` +
        `${addressLine}\n\n` +
        `${body}\n\n` +
        `${txLine}`;

      try {
        await bot.telegram.sendMessage(row.chat_id, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      } catch (err) {
        console.error(`[tracker] failed to notify chat ${row.chat_id}:`, err);
      }
    }

    if (overflow > 0) {
      const addrUrl = chain.explorerAddressUrl(row.address);
      try {
        await bot.telegram.sendMessage(
          row.chat_id,
          `… и ещё ${overflow} событий этого контракта в блоках ${fromBlock}–${toBlock}. ` +
            `Показаны первые ${MAX_ALERTS_PER_POLL}.` +
            (addrUrl ? `\n<a href="${addrUrl}">Все события в эксплорере ↗</a>` : ""),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
      } catch (err) {
        console.error(`[tracker] failed to notify chat ${row.chat_id}:`, err);
      }
    }

    updateLastBlock(row.id, toBlock);
  } catch (err) {
    console.error(`[tracker] getLogs failed for ${row.chain}:${row.address}`, err);
  }
}

export function startTracker(bot: Telegraf): () => void {
  let running = false;

  const tick = async () => {
    if (running) return; // don't overlap polls
    running = true;
    try {
      const rows = listAllTracked();
      if (rows.length === 0) return;

      const byChain = new Map<string, TrackedRow[]>();
      for (const row of rows) {
        if (!byChain.has(row.chain)) byChain.set(row.chain, []);
        byChain.get(row.chain)!.push(row);
      }

      for (const [chainKey, chainRows] of byChain) {
        try {
          const client = getClient(chainKey);
          const currentBlock = await client.getBlockNumber();
          for (const row of chainRows) {
            await pollOne(bot, row, currentBlock);
          }
        } catch (err) {
          console.error(`[tracker] chain poll failed for ${chainKey}`, err);
        }
      }
    } finally {
      running = false;
    }
  };

  const interval = setInterval(tick, env.trackPollIntervalMs);
  // Kick off an initial poll shortly after startup.
  setTimeout(tick, 5_000);

  return () => clearInterval(interval);
}
