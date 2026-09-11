import fs from "node:fs";
import path from "node:path";
import { CHAINS } from "../config/chains";
import { env, hasCustomRpc, rpcUrlsFor } from "../config/env";
import { mapWithConcurrency } from "./concurrency";

/**
 * Which endpoints actually answer, so the reader starts on one of them.
 *
 * viem's fallback transport walks its endpoints in the order it was given
 * and pays a full timeout for each one that does not answer before trying
 * the next. That order was static and blind: Kroma lists five endpoints and
 * the first is a hostname that no longer resolves, so every single read
 * began by waiting out a dead node. On a chain where only the third or fifth
 * endpoint works, a read spends two to four timeouts before it succeeds -
 * and long enough that other things time out too, which is how a chain that
 * is reachable comes to look unreachable.
 *
 * So the order is measured. Nothing here decides whether a chain works; it
 * decides which of its nodes to ask first, which is the difference between
 * a report that arrives and one that gives up.
 */

/** How long one node gets to name its own chain id. */
const PROBE_TIMEOUT_MS = 5_000;

/** Chains probed at once. Each probes all of its endpoints in parallel. */
const SWEEP_CONCURRENCY = 12;

/** How often the whole table is re-measured. Nodes die on their own schedule. */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Waited before the first sweep, so it does not race the bot's own startup. */
const FIRST_SWEEP_DELAY_MS = 20_000;

interface EndpointHealth {
  /** Answered with the chain id we expected. */
  ok: boolean;
  /** Round trip in milliseconds, for ordering the healthy ones. */
  ms: number;
  at: number;
}

/** url -> what it did last time it was asked. */
const health = new Map<string, EndpointHealth>();

export function healthOf(url: string): EndpointHealth | undefined {
  return health.get(url);
}

/**
 * The endpoints of a chain, best first.
 *
 * A configured RPC stays first whatever the measurements say: someone paid
 * for it, and demoting it behind a public node on one slow probe would be
 * the bot overruling its operator. Everything else is ordered by what it
 * did: answered (fastest first), never asked, refused.
 */
export function orderEndpoints(
  urls: string[],
  pinnedFirst: boolean,
  lookup: (url: string) => EndpointHealth | undefined = healthOf
): string[] {
  if (urls.length <= 1) return urls;

  const pinned = pinnedFirst ? urls.slice(0, 1) : [];
  const rest = pinnedFirst ? urls.slice(1) : urls;

  const scored = rest.map((url, index) => ({ url, index, h: lookup(url) }));
  scored.sort((a, b) => {
    const rankOf = (x: typeof a) => (x.h === undefined ? 1 : x.h.ok ? 0 : 2);
    const byRank = rankOf(a) - rankOf(b);
    if (byRank !== 0) return byRank;
    // Among nodes that answered, the quicker one. Among the rest, the order
    // the registries gave, which is their own idea of quality.
    if (a.h?.ok && b.h?.ok) return a.h.ms - b.h.ms;
    return a.index - b.index;
  });

  return [...pinned, ...scored.map((s) => s.url)];
}

/** Endpoints for a chain, measured order applied. */
export function orderedRpcUrls(chainKey: string): string[] {
  return orderEndpoints(rpcUrlsFor(chainKey), hasCustomRpc(chainKey));
}

/* ------------------------------------------------------------------ */

/**
 * Asks a node which chain it is.
 *
 * eth_chainId rather than a block number: it is the cheapest question there
 * is, and the answer can be checked. A URL quietly repointed at another
 * network returns a block number perfectly happily, and ranking it first
 * would be worse than ranking a dead node first.
 */
async function probe(url: string, expected: number): Promise<EndpointHealth> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    if (!response.ok) return { ok: false, ms, at: Date.now() };
    const body = (await response.json()) as { result?: unknown };
    const ok = typeof body.result === "string" && Number(BigInt(body.result)) === expected;
    return { ok, ms, at: Date.now() };
  } catch {
    return { ok: false, ms: Date.now() - started, at: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

export interface SweepResult {
  chains: number;
  endpoints: number;
  alive: number;
  /** Chains whose best endpoint was not the one that would have been used. */
  reordered: number;
}

/**
 * Measures every endpoint of every chain and records what it found.
 *
 * Returns how many chains it reordered, which is the number worth watching:
 * each one is a chain that was starting its reads on a node that does not
 * answer.
 */
export async function sweepRpcHealth(): Promise<SweepResult> {
  const result: SweepResult = { chains: 0, endpoints: 0, alive: 0, reordered: 0 };

  await mapWithConcurrency(CHAINS, SWEEP_CONCURRENCY, async (chain) => {
    const urls = rpcUrlsFor(chain.key);
    if (urls.length === 0) return;
    const firstBefore = orderedRpcUrls(chain.key)[0];

    const answers = await Promise.all(urls.map((url) => probe(url, chain.viemChain.id)));
    urls.forEach((url, i) => health.set(url, answers[i]));

    result.chains++;
    result.endpoints += urls.length;
    result.alive += answers.filter((a) => a.ok).length;
    if (orderedRpcUrls(chain.key)[0] !== firstBefore) result.reordered++;
  });

  // Clients hold the order they were built with, so they have to go.
  invalidateClients();
  savePersisted();
  return result;
}

/** How many of a chain's endpoints answered when last measured. */
export function healthyCount(chainKey: string): number {
  let alive = 0;
  for (const url of rpcUrlsFor(chainKey)) if (health.get(url)?.ok) alive++;
  return alive;
}

/**
 * Whether a chain has nothing to fall back to.
 *
 * Forty-three chains answer on exactly one node. For those there is no
 * second chance inside a single read: the fallback has nowhere to fall. So
 * they are asked more gently and given more patience, which is the opposite
 * of what a chain with six healthy nodes needs.
 */
export function isFragile(chainKey: string): boolean {
  const measured = rpcUrlsFor(chainKey).some((url) => health.has(url));
  return measured && healthyCount(chainKey) <= 1;
}

/* ------------------------------------------------------------------ */

/** Chains queued for an unscheduled re-measure, and the timer that drains them. */
const suspect = new Set<string>();
let remeasureTimer: NodeJS.Timeout | undefined;

/** Waited before acting on a chain's failures, so a burst costs one sweep. */
const REMEASURE_DEBOUNCE_MS = 30_000;

/**
 * Says a chain's reads are failing, so its nodes get measured again soon.
 *
 * Without this the ordering is only as fresh as the last scheduled sweep,
 * and a node that dies a minute after one stays in first place for six
 * hours - with every read of that chain beginning by waiting it out. The
 * reads themselves know when something has gone wrong long before the next
 * sweep would; this is them saying so.
 *
 * Debounced, because a failing chain fails several reads at once and one
 * re-measure answers all of them.
 */
export function noteChainTrouble(chainKey: string): void {
  suspect.add(chainKey);
  if (remeasureTimer) return;
  remeasureTimer = setTimeout(() => {
    remeasureTimer = undefined;
    const chains = [...suspect];
    suspect.clear();
    remeasure(chains).catch((err) => console.error("[rpc] повторный замер не удался:", err));
  }, REMEASURE_DEBOUNCE_MS);
  // Not keeping the process alive for a measurement nobody is waiting on.
  remeasureTimer.unref?.();
}

async function remeasure(chainKeys: string[]): Promise<void> {
  let changed = 0;
  for (const chainKey of chainKeys) {
    const chain = CHAINS.find((c) => c.key === chainKey);
    if (!chain) continue;
    const urls = rpcUrlsFor(chainKey);
    if (urls.length === 0) continue;
    const firstBefore = orderedRpcUrls(chainKey)[0];
    const answers = await Promise.all(urls.map((url) => probe(url, chain.viemChain.id)));
    urls.forEach((url, i) => health.set(url, answers[i]));
    if (orderedRpcUrls(chainKey)[0] !== firstBefore) changed++;
  }
  if (changed > 0) {
    console.log(`[rpc] после отказов пересчитан порядок узлов у ${changed} сетей`);
    invalidateClients();
  }
  savePersisted();
}

/* ------------------------------------------------------------------ */

let invalidateClients: () => void = () => {};

/** Wired by the client factory, which is the thing holding the stale order. */
export function onHealthChanged(invalidate: () => void): void {
  invalidateClients = invalidate;
}

function persistPath(): string {
  return path.join(path.dirname(env.dbPath), "rpc-health.json");
}

/**
 * Kept on disk so a restart does not start blind.
 *
 * The first minutes after a deploy are when the bot is most likely to be
 * asked something, and measuring takes a minute or two - without this, every
 * deploy would spend that window walking dead nodes again.
 */
function savePersisted(): void {
  try {
    const rows: Record<string, EndpointHealth> = {};
    for (const [url, h] of health) rows[url] = h;
    fs.mkdirSync(path.dirname(persistPath()), { recursive: true });
    fs.writeFileSync(persistPath(), JSON.stringify(rows), "utf8");
  } catch {
    // No volume, read-only disk: the bot measures again next time.
  }
}

export function loadPersisted(): number {
  try {
    const rows = JSON.parse(fs.readFileSync(persistPath(), "utf8")) as Record<string, EndpointHealth>;
    for (const [url, h] of Object.entries(rows)) {
      if (typeof h?.ok === "boolean" && typeof h?.ms === "number") health.set(url, h);
    }
    return health.size;
  } catch {
    return 0;
  }
}

/** Measures now, then every few hours. Returns a stop function. */
export function startRpcHealth(): () => void {
  const restored = loadPersisted();
  if (restored > 0) {
    console.log(`[rpc] порядок узлов восстановлен с диска: ${restored} эндпоинтов`);
    invalidateClients();
  }

  const run = () => {
    sweepRpcHealth()
      .then((r) =>
        console.log(
          `[rpc] проверено ${r.endpoints} узлов на ${r.chains} сетях: отвечают ${r.alive}; ` +
            `порядок изменён у ${r.reordered} сетей`
        )
      )
      .catch((err) => console.error("[rpc] не удалось измерить узлы:", err));
  };

  const first = setTimeout(run, FIRST_SWEEP_DELAY_MS);
  const repeat = setInterval(run, REFRESH_INTERVAL_MS);
  return () => {
    clearTimeout(first);
    clearInterval(repeat);
  };
}

/** Exposed for /diag, which reports what the ordering is doing. */
export function healthSummary(): { measured: number; alive: number; chainsWithDeadFirst: number } {
  let alive = 0;
  for (const h of health.values()) if (h.ok) alive++;
  let chainsWithDeadFirst = 0;
  for (const chain of CHAINS) {
    const urls = rpcUrlsFor(chain.key);
    if (urls.length <= 1) continue;
    const first = health.get(urls[0]);
    if (first && !first.ok && orderedRpcUrls(chain.key)[0] !== urls[0]) chainsWithDeadFirst++;
  }
  return { measured: health.size, alive, chainsWithDeadFirst };
}
