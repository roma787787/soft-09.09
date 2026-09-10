/**
 * Runs an operation over a list, a bounded number at a time.
 *
 * A pool rather than batches: batches wait for their slowest member, so one
 * dead chain stalls eleven healthy ones and the whole run takes as long as
 * the sum of the worst in each batch.
 *
 * Bounded rather than all at once, which is the part that keeps being
 * relearned. Firing two hundred requests together does not measure two
 * hundred nodes - they queue inside Node, the wait is charged to the
 * request, and the ones at the back time out and are reported as down when
 * they were never really asked. In this bot that reads as "no liquidity
 * here", which is the opposite of what it means.
 *
 * Results come back in the order of the input, whatever order they finished.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
