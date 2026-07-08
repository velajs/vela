import { useCallback, useSyncExternalStore } from 'react';
import type { ConnectionStatus } from '@velajs/client';
import { useLiveClient } from './context';

/** The client's aggregate connection status, live. */
export function useConnectionStatus(): ConnectionStatus {
  const client = useLiveClient();
  const subscribe = useCallback(
    (onStoreChange: () => void) => client.onConnectionStatus(() => onStoreChange()),
    [client],
  );
  const getSnapshot = useCallback(() => client.connectionStatus(), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
