import { useCallback, useSyncExternalStore } from 'react';
import type { ClientQueryRef } from '@velajs/client';
import type { LiveClient, LiveContractShape } from '@velajs/client';

/**
 * Read and write a local-only client query (see `createClientQuery`). Built on
 * `useSyncExternalStore`, shared across every consumer of the same ref, with no
 * undefined flash — the snapshot is the stored value or the ref's default,
 * always referentially stable between writes.
 *
 * ```tsx
 * const filter = createClientQuery('todos.filter', 'all');
 * const [value, setValue] = useClientQuery(filter);
 * ```
 */
export function createUseClientQuery<C extends LiveContractShape<C>>(
  useLiveClient: () => LiveClient<C>,
) {
  function useClientQuery<T>(ref: ClientQueryRef<T>): [T, (value: T) => void] {
    const client = useLiveClient();
    const subscribe = useCallback(
      (onStoreChange: () => void) => client.subscribeClientQuery(ref, onStoreChange),
      [client, ref],
    );
    const getSnapshot = useCallback(() => client.getClientQuery(ref), [client, ref]);
    const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const setValue = useCallback((next: T) => client.setClientQuery(ref, next), [client, ref]);
    return [value, setValue];
  }

  return useClientQuery;
}
