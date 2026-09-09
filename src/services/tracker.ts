import type { Telegraf } from "telegraf";
import { getClient } from "./rpcClient";
import { listAllTracked, updateLastBlock, type TrackedRow } from "./db";
import { getChain } from "../config/chains";
import { env } from "../config/env";
import { tryDecodeEvent } from "./eventCatalog";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function pollOne(bot: Telegraf, row: TrackedRow, currentBlock: bigint): Promise<void> {
  const chain = getChain(row.chain);
  if (!chain) return;
  const client = getClient(row.chain);

  const lastBlock = row.last_block ? BigInt(row.last_block) : currentBlock - env.trackInitialLookbackBlocks;
  const fromBlock = lastBlock < 0n ? 0n : lastBlock + (row.last_block ? 1n : 0n);
  if (fromBlock > currentBlock) return;

  const toBlock = fromBlock + env.trackMaxBlockRange - 1n > currentBlock ? currentBlock : fromBlock + env.trackMaxBlockRange - 1n;

  try {
    const logs = await client.getLogs({
      address: row.address as `0x${string}`,
      fromBlock,
      toBlock,
    });

    for (const log of logs) {
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
        body = `New event (${log.topics.length} topics, undecoded)`;
      }

      const label = row.label || row.protocol || "bridge contract";
      const text =
        `🔔 <b>${escapeHtml(chain.label)}</b> — ${escapeHtml(label)}\n` +
        `<a href="${addrUrl}">${escapeHtml(row.address)}</a>\n\n` +
        `${body}\n\n` +
        `<a href="${txUrl}">tx ↗</a> · block ${log.blockNumber}`;

      try {
        await bot.telegram.sendMessage(row.chat_id, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
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
