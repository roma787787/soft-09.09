/**
 * Endpoints learned at runtime, on top of the ones generated at build time.
 *
 * The generated table is three public registries deep and still leaves
 * chains with one working node or none: /diag found fourteen answering the
 * server with a refusal and seven whose only listed node is broken, and a
 * chain with no reachable node drops out of every report - which reads as
 * "no liquidity here" rather than "nobody could ask".
 *
 * The bridges publish endpoints of their own for the chains they are
 * deployed on, and the bot already downloads that metadata for other
 * reasons. Those endpoints were being used only for chains being added to
 * the table and thrown away for chains already in it, which is exactly
 * backwards: a chain already in the table with one dead node is the one
 * that needs an alternate.
 *
 * Kept in memory rather than written down. They come from a source the bot
 * refreshes on its own schedule, and a stale endpoint frozen into a file is
 * the problem this is meant to solve, not the fix.
 */
const byChainId = new Map<number, string[]>();

/** Endpoints that are worth trying: public, and needing no key we lack. */
function usable(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("https://") && !/\$\{|API_KEY/i.test(url);
}

/**
 * Records endpoints for a chain, keeping the order they arrived in and
 * never the same one twice.
 *
 * Additive on purpose: a later refresh that publishes fewer endpoints must
 * not take away one that is currently the only working node.
 */
export function learnEndpoints(chainId: number, urls: readonly unknown[]): number {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return 0;

  const known = byChainId.get(chainId) ?? [];
  const seen = new Set(known);
  let added = 0;
  for (const url of urls) {
    if (!usable(url)) continue;
    const trimmed = url.replace(/\/+$/, "");
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    known.push(trimmed);
    added++;
  }
  if (known.length > 0) byChainId.set(chainId, known);
  return added;
}

export function learnedEndpoints(chainId: number): string[] {
  return byChainId.get(chainId) ?? [];
}

/** How many chains and endpoints have been learned, for /sources and /diag. */
export function learnedSummary(): { chains: number; endpoints: number } {
  let endpoints = 0;
  for (const urls of byChainId.values()) endpoints += urls.length;
  return { chains: byChainId.size, endpoints };
}

/** Only for tests: the table is process-wide and additive by design. */
export function forgetLearnedEndpoints(): void {
  byChainId.clear();
}
