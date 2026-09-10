import type { Telegraf, Context } from "telegraf";
import { CHAINS } from "../../config/chains";
import { getClient } from "../../services/rpcClient";
import { hasCustomRpc, rpcUrlsFor } from "../../config/env";
import { plural, capToTelegramLimit } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Chains in flight at once. Not all at once: firing a hundred and fifty
 * requests together does not measure a hundred and fifty nodes, they queue
 * inside Node and the timings report how long each waited its turn -
 * Avalanche on a private endpoint went from 326 ms to 71 seconds.
 */
const HEALTH_CHECK_CONCURRENCY = 20;

/**
 * How long one chain gets. A chain with four fallback endpoints and a 12 s
 * transport timeout can otherwise spend a minute and a half proving it is
 * down, which it does not need: a node that has not produced a block number
 * in five seconds is not one this bot can read a balance from anyway.
 */
const CHAIN_DEADLINE_MS = 5_000;

/**
 * And how long the whole sweep gets. Telegraf abandons a handler after 90
 * seconds and answers with its generic error, which from the phone is
 * indistinguishable from a bot that is down - so the sweep has to finish
 * well inside that on its own.
 */
const TOTAL_BUDGET_MS = 50_000;

interface ChainHealth {
  chainKey: string;
  label: string;
  ok: boolean;
  blockNumber?: bigint;
  ms?: number;
  error?: string;
  /** Never asked: the sweep ran out of time before reaching this chain. */
  skipped?: boolean;
  custom: boolean;
}

async function checkChain(chainKey: string, label: string): Promise<ChainHealth> {
  const custom = hasCustomRpc(chainKey);
  const started = Date.now();
  try {
    // Raced against a deadline rather than left to the transport's own
    // timeouts, which multiply: every fallback endpoint gets its full
    // timeout, and each of those is retried.
    const blockNumber = await Promise.race([
      getClient(chainKey).getBlockNumber(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`нет ответа за ${CHAIN_DEADLINE_MS / 1000} с`)), CHAIN_DEADLINE_MS)
      ),
    ]);
    return { chainKey, label, ok: true, blockNumber, ms: Date.now() - started, custom };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const firstLine = message.split("\n")[0].trim();
    return {
      chainKey,
      label,
      ok: false,
      error: firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine,
      custom,
    };
  }
}

/**
 * A pool, not lockstep batches. Batches wait for their slowest member, so a
 * single dead chain stalls eleven healthy ones and the sweep takes as long
 * as the sum of the worst chain in each batch.
 */
async function sweep(deadline: number): Promise<ChainHealth[]> {
  const health: ChainHealth[] = new Array(CHAINS.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= CHAINS.length) return;
      const chain = CHAINS[index];
      if (Date.now() > deadline) {
        health[index] = {
          chainKey: chain.key,
          label: chain.label,
          ok: false,
          skipped: true,
          custom: hasCustomRpc(chain.key),
        };
        continue;
      }
      health[index] = await checkChain(chain.key, chain.label);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(HEALTH_CHECK_CONCURRENCY, CHAINS.length) }, () => worker())
  );
  return health;
}

/**
 * Reports whether each chain's RPC actually answers. Without this, an
 * unreachable node is indistinguishable from "the address is not a bridge",
 * and there is no way to tell them apart from a phone.
 */
export function registerDiagCommand(bot: Telegraf) {
  bot.command("diag", async (ctx: Context) => {
    await ctx.sendChatAction("typing");

    const health = await sweep(Date.now() + TOTAL_BUDGET_MS);

    const skipped = health.filter((h) => h.skipped);
    const failed = health.filter((h) => !h.ok && !h.skipped);
    const ok = health.filter((h) => h.ok);

    // A line per chain stopped fitting somewhere past forty of them. What
    // matters is which chains failed and why; the ones that answered only
    // need to be named, with the slowest called out - a node taking a second
    // is the next one to start failing.
    const lines: string[] = [];
    if (health.length > 40) {
      for (const h of failed) {
        lines.push(
          `❌ <b>${esc(h.label)}</b> <i>(${h.custom ? "свой RPC" : "публичный"})</i>\n   <code>${esc(h.error ?? "нет ответа")}</code>`
        );
      }
      if (failed.length > 0) lines.push("");

      const slowest = [...ok].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 5);
      lines.push(`✅ Ответили: ${ok.length}`);
      if (slowest.length > 0) {
        lines.push(
          `Самые медленные: ${slowest.map((h) => `${esc(h.label)} ${h.ms} мс`).join(", ")}`,
          ""
        );
      }
      lines.push(esc(ok.map((h) => h.label).join(", ")));
    } else {
      for (const h of health) {
        const source = h.custom ? "свой RPC" : "публичный";
        lines.push(
          h.ok
            ? `✅ <b>${esc(h.label)}</b> — блок ${h.blockNumber}, ${h.ms} мс <i>(${source})</i>`
            : `❌ <b>${esc(h.label)}</b> <i>(${source})</i>\n   <code>${esc(h.error ?? "нет ответа")}</code>`
        );
      }
    }

    const header = `🩺 Связь с сетями: ${ok.length} из ${health.length}\n\n`;

    let footer = "";
    if (skipped.length > 0) {
      // Said outright rather than counted with the failures: these chains
      // were never asked, and reporting them as down would be a lie that
      // sends the user hunting for RPC keys they do not need.
      footer +=
        `\n\n⏳ Не успели проверить ${skipped.length} ` +
        `${plural(skipped.length, "сеть", "сети", "сетей")} за ${TOTAL_BUDGET_MS / 1000} с — ` +
        `это не отказ, просто очередь. Повтори /diag: ` +
        `${esc(skipped.slice(0, 12).map((h) => h.label).join(", "))}` +
        `${skipped.length > 12 ? " и другие" : ""}.`;
    }
    if (failed.length > 0) {
      // Naming the variables outright: deriving SWELL_RPC_URL from
      // "Swellchain" is a small step at a desk and an annoying one on a
      // phone, which is where this bot is actually operated from.
      const vars = failed
        .map((h) => CHAINS.find((c) => c.key === h.chainKey)?.rpcEnvVar)
        .filter((v): v is string => !!v)
        .map((v) => `<code>${esc(v)}</code>`)
        .join(", ");
      footer +=
        `\n\nСети с ❌ сейчас не проверяются командой /info. ` +
        `Публичные ноды часто отказывают серверам хостинга. ` +
        `Лечится своим RPC — пропиши его в ${vars}.`;
    }

    // Counted through rpcUrlsFor, not the chain table: the generated
    // fallbacks are a separate source, and counting only what viem carries
    // would report chains as fragile that have four alternates behind them.
    const thin = CHAINS.filter((c) => rpcUrlsFor(c.key).length === 1 && !hasCustomRpc(c.key)).length;
    if (thin > 0) {
      // A chain with one endpoint is not broken, it is one refusal away from
      // being broken - and a chain that drops out of a report reads as "no
      // liquidity here" rather than as a node that said no.
      footer += `\n\nУ ${thin} ${plural(thin, "сети", "сетей", "сетей")} только один публичный узел: ` +
        `сегодня отвечает, но запасного у него нет.`;
    }

    // Forty-two chains is close enough to the message limit that a few
    // multi-line failures would push it over, and a report Telegram refuses
    // looks to the user exactly like a bot that is down.
    await ctx.reply(capToTelegramLimit(header + lines.join("\n") + footer), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
