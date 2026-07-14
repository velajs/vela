import { useCallback, useSyncExternalStore } from 'react';
import { useLiveClient } from './context';

/**
 * The number of writes waiting in the offline mutation queue, live. Zero when
 * no offline queue is configured. Handy for an "N unsaved changes" indicator.
 */
export function usePendingMutations(): number {
  const client = useLiveClient();
  const subscribe = useCallback(
    (onStoreChange: () => void) => client.onPendingChange(onStoreChange),
    [client],
  );
  const getSnapshot = useCallback(() => client.pendingMutations(), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
