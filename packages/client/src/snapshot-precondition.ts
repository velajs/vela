import type { LiveClient } from './live-client';
import { stableStringify } from './stable-key';
import type { ArgsOf, LiveContract } from './types';

/**
 * A client-side optimistic-concurrency guard for offline writes. Captures a
 * stable snapshot of a live query's current value at enqueue time and returns
 * a predicate that reports whether that value is still unchanged. Threaded via
 * {@link MutateOptions.precondition}, the offline queue drops the write with
 * `OFFLINE_PRECONDITION_FAILED` (instead of replaying it) when the predicate is
 * false at replay — i.e. the value the write assumed changed while offline.
 *
 * ```ts
 * await client.mutate('/todos/t1', { done: true }, {
 *   precondition: createSnapshotPrecondition(client, 'todos.list', { listId }),
 * });
 * ```
 */
export function createSnapshotPrecondition<C extends LiveContract, Q extends keyof C & string>(
  client: LiveClient<C>,
  query: Q,
  args: ArgsOf<C, Q>,
  room?: string,
): () => boolean {
  const snapshot = client.peek(query, args, room);
  const snapshotKey = snapshot === undefined ? undefined : stableStringify(snapshot);
  return () => {
    const current = client.peek(query, args, room);
    // Nothing then, nothing now — no assumption to violate.
    if (snapshotKey === undefined && current === undefined) return true;
    // Appeared or disappeared — the assumed presence changed.
    if (snapshotKey === undefined || current === undefined) return false;
    return stableStringify(current) === snapshotKey;
  };
}
