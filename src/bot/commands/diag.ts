import type { Telegraf, Context } from "telegraf";
import { CHAINS } from "../../config/chains";
import { hasCustomRpc, rpcUrlsFor } from "../../config/env";
import { MAX_ENDPOINTS_PER_CHAIN } from "../../services/rpcClient";
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
/** Chains in flight at once. Each of them probes several nodes. */
const HEALTH_CHECK_CONCURRENCY = 20;

/**
 * How long one node gets to produce a block number. A node slower than this
 * is not one a report can be built on: /info asks it half a dozen questions
 * per bridge, not one.
 */
const NODE_DEADLINE_MS = 6_000;

/**
 * Nodes probed per chain - the same ones the balance reader will use, taken
 * from it rather than repeated here. A diagnostic that measures a different
 * set of nodes than the reports do is worse than none: it would clear a
 * chain that /info cannot read, or condemn one it can.
 */
const MAX_NODES_PROBED = MAX_ENDPOINTS_PER_CHAIN;

/**
 * And how long the whole sweep gets. Telegraf abandons a handler after five
 * minutes, and a report that never arrives is indistinguishable from a bot
 * that is down.
 */
const TOTAL_BUDGET_MS = 75_000;

interface NodeHealth {
  url: string;
  ok: boolean;
  ms: number;
  blockNumber?: bigint;
  error?: string;
}

interface ChainHealth {
  chainKey: string;
  label: string;
  ok: boolean;
  blockNumber?: bigint;
  ms?: number;
  /** How many of the chain's nodes answered, and how many were asked. */
  alive: number;
  asked: number;
  error?: string;
  /** Never asked: the sweep ran out of time before reaching this chain. */
  skipped?: boolean;
  custom: boolean;
}

/**
 * One node, asked directly rather than through viem.
 *
 * Deliberately not through the chain's client: viem's fallback transport
 * walks its endpoints in order, giving each one a full timeout before moving
 * on, so a chain whose first node is dead and whose second is healthy takes
 * half a minute to say so - and under any deadline short enough for a chat
 * command, it says the wrong thing. Metis lists twelve nodes. Asking them at
 * once measures what actually matters: whether this chain can be read at
 * all.
 */
/**
 * The reason, not the wrapper. Node reports every transport failure as
 * "fetch failed" and puts the diagnosis one level down in `cause`: the
 * hostname that no longer resolves, the refused connection, the expired
 * certificate. Sixteen chains reported "fetch failed" and there was no way
 * to tell a domain that has been dead for a year from a node that is merely
 * busy - which are opposite problems with opposite fixes.
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as NodeJS.ErrnoException).code;
    const line = (code ? `${current.message} (${code})` : current.message).split("\n")[0].trim();
    if (line && !parts.includes(line)) parts.push(line);
    current = (current as { cause?: unknown }).cause;
  }
  // The wrapper is worth keeping only when it is all there is.
  const informative = parts.filter((p) => p !== "fetch failed");
  return (informative.length > 0 ? informative : parts).join(" ← ") || String(err);
}

async function probeNode(url: string): Promise<NodeHealth> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NODE_DEADLINE_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    if (!response.ok) return { url, ok: false, ms, error: `HTTP ${response.status}` };
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) return { url, ok: false, ms, error: String(body.error.message ?? "ошибка RPC") };
    if (typeof body.result !== "string") return { url, ok: false, ms, error: "ответ без result" };
    return { url, ok: true, ms, blockNumber: BigInt(body.result) };
  } catch (err) {
    const ms = Date.now() - started;
    if (controller.signal.aborted) return { url, ok: false, ms, error: `нет ответа за ${NODE_DEADLINE_MS / 1000} с` };
    return { url, ok: false, ms, error: describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkChain(chainKey: string, label: string): Promise<ChainHealth> {
  const custom = hasCustomRpc(chainKey);
  const urls = rpcUrlsFor(chainKey)
    .filter((u) => u.startsWith("http"))
    .slice(0, MAX_NODES_PROBED);
  if (urls.length === 0) {
    return { chainKey, label, ok: false, alive: 0, asked: 0, error: "нет ни одного узла", custom };
  }

  const nodes = await Promise.all(urls.map(probeNode));
  const alive = nodes.filter((n) => n.ok);
  if (alive.length === 0) {
    // The shortest of the failures, because "нет ответа за 6 с" repeated six
    // times says less than the one node that bothered to explain itself.
    const explained = nodes.find((n) => n.error && !n.error.startsWith("нет ответа"));
    const raw = (explained ?? nodes[0]).error ?? "нет ответа";
    return {
      chainKey,
      label,
      ok: false,
      alive: 0,
      asked: nodes.length,
      error: raw.length > 80 ? `${raw.slice(0, 80)}…` : raw,
      custom,
    };
  }

  // The fastest node that answered, not the average: that is the one viem
  // will end up on once the dead ones are skipped.
  const best = alive.reduce((a, b) => (a.ms <= b.ms ? a : b));
  return {
    chainKey,
    label,
    ok: true,
    blockNumber: best.blockNumber,
    ms: best.ms,
    alive: alive.length,
    asked: nodes.length,
    custom,
  };
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
          alive: 0,
          asked: 0,
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
      // Grouped by reason, not one two-line block per chain. Seventy chains
      // each saying "нет ответа за 6 с" on its own line filled the whole
      // message and pushed the part that carries information - which chains
      // answered - off the end of it.
      const byReason = new Map<string, ChainHealth[]>();
      for (const h of failed) {
        const reason = h.error ?? "нет ответа";
        const group = byReason.get(reason);
        if (group) group.push(h);
        else byReason.set(reason, [h]);
      }
      const groups = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
      for (const [reason, chains] of groups) {
        lines.push(
          `❌ <b>${esc(reason)}</b> — ${chains.length}\n   ${esc(chains.map((h) => h.label).join(", "))}`
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
            ? `✅ <b>${esc(h.label)}</b> — блок ${h.blockNumber}, ${h.ms} мс, ${h.alive} из ${h.asked} ${plural(h.asked, "узла", "узлов", "узлов")} <i>(${source})</i>`
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
      const names = failed
        .map((h) => CHAINS.find((c) => c.key === h.chainKey)?.rpcEnvVar)
        .filter((v): v is string => !!v);
      // Capped, because seventy variable names is not a list anyone acts on
      // - it is the rest of the report pushed out of the message.
      const vars = names.slice(0, 8).map((v) => `<code>${esc(v)}</code>`).join(", ");
      const rest = names.length > 8 ? ` и ещё ${names.length - 8}` : "";
      footer +=
        `\n\nСети с ❌ сейчас не проверяются командой /info. ` +
        `Публичные ноды часто отказывают серверам хостинга. ` +
        `Лечится своим RPC — пропиши его в ${vars}${rest}.`;
    }

    // Measured, not counted from the config. A chain can list twelve nodes
    // and have one of them alive, which is the state worth reporting: it is
    // not broken, it is one refusal away from being broken - and a chain
    // that drops out of a report reads as "no liquidity here" rather than as
    // a node that said no.
    const fragile = ok.filter((h) => h.alive === 1 && !h.custom);
    if (fragile.length > 0) {
      footer +=
        `\n\n⚠️ У ${fragile.length} ${plural(fragile.length, "сети", "сетей", "сетей")} ` +
        `отвечает ровно один узел: ` +
        `${esc(fragile.slice(0, 10).map((h) => h.label).join(", "))}` +
        `${fragile.length > 10 ? " и другие" : ""}.`;
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
