import type { LiveClient } from './live-client';
import { stableStringify } from './stable-key';
import type { ArgsOf, LiveContractShape } from './types';

/**
 * A client-side optimistic-concurrency guard for offline writes. Captures a
 * stable snapshot of an active live query's current value at enqueue time and
 * returns a predicate that reports whether that value is still unchanged.
 * Threaded via {@link MutateOptions.precondition}, the offline queue drops the
 * write with `OFFLINE_PRECONDITION_FAILED` (instead of replaying it) when the
 * predicate is false at replay — i.e. the observed value the write assumed
 * changed while offline.
 *
 * Values are compared only when an active subscription backed both reads. If
 * either read is unobserved (for example, the originating component unmounted
 * before replay), the predicate returns true because subscription absence is
 * not evidence that the underlying value changed.
 *
 * ```ts
 * await client.mutate('/todos/t1', { done: true }, {
 *   precondition: createSnapshotPrecondition(client, 'todos.list', { listId }),
 * });
 * ```
 */
export function createSnapshotPrecondition<
  C extends LiveContractShape<C>,
  Q extends keyof C & string,
>(client: LiveClient<C>, query: Q, args: ArgsOf<C, Q>, room?: string): () => boolean {
  const snapshot = client.peekActiveQuerySnapshot(query, args, room);
  const snapshotKey =
    snapshot.present && snapshot.value !== undefined ? stableStringify(snapshot.value) : undefined;
  return () => {
    const current = client.peekActiveQuerySnapshot(query, args, room);
    // Either read had no live subscription: there is no evidence of a conflict.
    if (!snapshot.present || !current.present) return true;
    // `stableStringify` intentionally accepts JSON data only, so preserve an
    // active subscription's undefined value as the third state explicitly.
    if (current.value === undefined) return snapshotKey === undefined;
    if (snapshotKey === undefined) return false;
    return stableStringify(current.value) === snapshotKey;
  };
}
