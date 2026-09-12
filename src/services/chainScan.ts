import { CHAINS } from "../config/chains";
import { detectOnChain, type DetectionOutcome } from "../protocols/registry";
import { mapWithConcurrency } from "./concurrency";
import { isUnreachable } from "./rpcHealth";

/**
 * Asking every chain what an address is, within bounds.
 *
 * Both /track and /info do this when no network is named, and they did it
 * with two copies of the same loop - which is how one of them came to be
 * fixed and the other left as it was. The table is discovered rather than
 * typed and has passed two hundred and fifty chains, so an unbounded sweep
 * stops measuring the nodes and starts measuring the queue, and a chain
 * whose endpoints are all dead costs six timeouts before getCode so much as
 * returns an error.
 *
 * Three bounds. Chains the last health sweep measured and found silent are
 * not asked at all - that is where most of the time went, re-learning what
 * was already recorded. Each of the rest gets its own deadline. The whole
 * sweep gets a budget, so the reply arrives while somebody is still looking
 * at the screen.
 */

/** Chains asked at once. Sized against the clock, not against politeness. */
const CONCURRENCY = 24;

/** How long one chain gets before the scan moves on. */
const CHAIN_DEADLINE_MS = 8_000;

/** The whole sweep. */
const TOTAL_BUDGET_MS = 90_000;

export interface ChainScanResult {
  perChain: Array<{ chain: string; outcome: DetectionOutcome }>;
  /** Chains actually asked: the table minus the ones known to be silent. */
  reachable: number;
  /** Of those, how many ran out of time - neither an answer nor a refusal. */
  skipped: number;
  /** Every chain in the table, so a report can say what it did not cover. */
  total: number;
}

/** Runs a probe under a deadline; a chain that overruns is not an answer. */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function scanChainsForAddress(address: `0x${string}`): Promise<ChainScanResult> {
  const reachable = CHAINS.filter((c) => !isUnreachable(c.key));
  const started = Date.now();
  let skipped = 0;

  const perChain = await mapWithConcurrency(reachable, CONCURRENCY, async (c) => {
    if (Date.now() - started > TOTAL_BUDGET_MS) {
      skipped++;
      return { chain: c.key, outcome: { results: [] } as DetectionOutcome };
    }
    const outcome = await withDeadline(detectOnChain(c.key, address), CHAIN_DEADLINE_MS);
    if (!outcome) skipped++;
    return { chain: c.key, outcome: outcome ?? ({ results: [] } as DetectionOutcome) };
  });

  return { perChain, reachable: reachable.length, skipped, total: CHAINS.length };
}

/**
 * One sentence about what the sweep did not cover, or nothing when it
 * covered everything. "Not found" and "not looked at" are different answers,
 * and only one of them means the address is not there.
 */
export function scanShortfall(scan: ChainScanResult): string {
  const unreachable = scan.total - scan.reachable;
  if (unreachable === 0 && scan.skipped === 0) return "";
  return (
    `Просмотрено ${scan.reachable - scan.skipped} сетей из ${scan.total}: ` +
    `${unreachable} не отвечают совсем, ${scan.skipped} не уложились в отведённое время. ` +
    "Если сеть известна, укажите её явно — это и быстрее, и точнее."
  );
}
