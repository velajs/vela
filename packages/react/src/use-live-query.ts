import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { argsKeyOf } from '@velajs/client';
import type { ArgsOf, LiveContract, ResultOf, SubscribeOptions } from '@velajs/client';
import { useLiveClient } from './context';

export interface UseLiveQueryOptions extends SubscribeOptions {
  /** Render without subscribing (conditional queries). */
  skip?: boolean;
}

/**
 * Subscribe to a live query. Returns `undefined` until the first
 * snapshot/hydrated value, then re-renders on every server push. Built on
 * `useSyncExternalStore` — the client guarantees referentially stable
 * snapshots between notifications, so there is no tearing and no external
 * cache library.
 *
 * ```tsx
 * const todos = useLiveQuery('todos.list', { listId }) ?? [];
 * ```
 */
export function useLiveQuery<C extends LiveContract, Q extends keyof C & string>(
  query: Q,
  args: ArgsOf<C, Q>,
  options?: UseLiveQueryOptions,
): ResultOf<C, Q> | undefined {
  const client = useLiveClient<C>();
  // Stable identity for the deps array — callers pass fresh object literals.
  const argsKey = useMemo(() => argsKeyOf(args), [args]);
  const { room, key, skip, onError } = options ?? {};

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (skip) return () => {};
      return client.subscribe(query, args, () => onStoreChange(), { room, key, onError });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- argsKey stands in for args; onError is deliberately unbound
    [client, query, argsKey, room, key, skip],
  );

  const getSnapshot = useCallback(
    () => (skip ? undefined : client.peek(query, args, room)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- argsKey stands in for args
    [client, query, argsKey, room, skip],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
