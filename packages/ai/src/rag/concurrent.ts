/**
 * Default ceiling on in-flight embed+upsert operations during `sync()`. Each
 * chunk triggers an embedder call plus a store write, so an unbounded fan-out
 * over a large document would exhaust a serverless request's subrequest budget.
 */
export const DEFAULT_SYNC_CONCURRENCY = 8;

/**
 * Order-preserving bounded-concurrency map: apply `task` to every item with at
 * most `limit` promises in flight, writing each result at its item's index.
 *
 * It drains outstanding work before rejecting when one task fails.
 * Callers stage work under generation-specific ids and clean that generation
 * on failure; cancellation would not make already-issued adapter writes atomic.
 */
export const mapWithConcurrency = async <T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('@velajs/ai/rag: concurrency `limit` must be a positive integer');
  }

  const results: R[] = [];
  let cursor = 0;

  const lane = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      // Each lane runs serially to enforce the shared concurrency ceiling.
      // oxlint-disable-next-line eslint/no-await-in-loop
      results[index] = await task(items[index] as T, index);
    }
  };

  const lanes = Array.from({ length: Math.min(limit, items.length) }, () => lane());
  const settled = await Promise.allSettled(lanes);
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;

  return results;
};
