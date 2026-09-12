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
  /** Only the chains that were actually asked and answered in time. */
  perChain: Array<{ chain: string; outcome: DetectionOutcome }>;
  /** Chains asked at all: the table minus the ones known to be silent. */
  reachable: number;
  /**
   * Chains that ran out of time, by key.
   *
   * Named rather than counted, because a caller has to be able to put them
   * with the chains that failed outright: a timeout returns an empty result
   * and no error, so counted as an answer it becomes "checked, nothing
   * there" about a chain nobody finished asking.
   */
  timedOut: string[];
  /** Chains not asked at all, the last sweep having found them silent. */
  unreachable: string[];
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
  const asked = CHAINS.filter((c) => !isUnreachable(c.key));
  const unreachable = CHAINS.filter((c) => isUnreachable(c.key)).map((c) => c.key);
  const started = Date.now();
  const timedOut: string[] = [];

  const answers = await mapWithConcurrency(asked, CONCURRENCY, async (c) => {
    if (Date.now() - started > TOTAL_BUDGET_MS) {
      timedOut.push(c.key);
      return undefined;
    }
    const outcome = await withDeadline(detectOnChain(c.key, address), CHAIN_DEADLINE_MS);
    if (!outcome) {
      timedOut.push(c.key);
      return undefined;
    }
    return { chain: c.key, outcome };
  });

  // A chain that ran out of time is left out of the results entirely rather
  // than handed back as an empty answer. Every caller counts what it got
  // back as "asked and answered", and an empty result with no error reads
  // exactly like "checked, nothing there".
  return {
    perChain: answers.filter((a): a is { chain: string; outcome: DetectionOutcome } => a !== undefined),
    reachable: asked.length,
    timedOut,
    unreachable,
    total: CHAINS.length,
  };
}

/**
 * One sentence about what the sweep did not cover, or nothing when it
 * covered everything. "Not found" and "not looked at" are different answers,
 * and only one of them means the address is not there.
 */
export function scanShortfall(scan: ChainScanResult): string {
  if (scan.unreachable.length === 0 && scan.timedOut.length === 0) return "";
  return (
    `Просмотрено ${scan.perChain.length} сетей из ${scan.total}: ` +
    `${scan.unreachable.length} не отвечают совсем, ${scan.timedOut.length} не уложились в отведённое время. ` +
    "Если сеть известна, укажите её явно — это и быстрее, и точнее."
  );
}
