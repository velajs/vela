import { useCallback, useSyncExternalStore } from 'react';
import type { ConnectionStatus } from '@velajs/client';
import type { LiveClient, LiveContractShape } from '@velajs/client';

/** The client's aggregate connection status, live. */
export function createUseConnectionStatus<C extends LiveContractShape<C>>(
  useLiveClient: () => LiveClient<C>,
) {
  function useConnectionStatus(): ConnectionStatus {
    const client = useLiveClient();
    const subscribe = useCallback(
      (onStoreChange: () => void) => client.onConnectionStatus(() => onStoreChange()),
      [client],
    );
    const getSnapshot = useCallback(() => client.connectionStatus(), [client]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  return useConnectionStatus;
}
