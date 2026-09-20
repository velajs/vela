import { createContext, createElement, useContext } from 'react';
import type { ReactNode } from 'react';
import type { LiveClient, LiveContract, LiveContractShape } from '@velajs/client';
import { createUseLiveQuery } from './use-live-query';
import { createUseLiveMutation } from './use-live-mutation';
import { createUseClientQuery } from './use-client-query';
import { createUseConnectionStatus } from './use-connection-status';
import { createUsePendingMutations } from './use-pending-mutations';
import { createUsePresence } from './use-presence';

export interface LiveProviderProps<C extends LiveContractShape<C>> {
  client: LiveClient<C>;
  children?: ReactNode;
}

/** Create one contract-bound provider and hook family per application. */
export function createLiveHooks<C extends LiveContractShape<C> = LiveContract>() {
  const context = createContext<LiveClient<C> | null>(null);
  function LiveProvider(props: LiveProviderProps<C>): ReturnType<typeof createElement> {
    return createElement(context.Provider, { value: props.client }, props.children);
  }
  function useLiveClient(): LiveClient<C> {
    const client = useContext(context);
    if (!client)
      throw new Error(
        'useLiveClient: wrap the tree in the LiveProvider returned by the same createLiveHooks() call.',
      );
    return client;
  }
  return {
    LiveProvider,
    useLiveClient,
    useLiveQuery: createUseLiveQuery(useLiveClient),
    useLiveMutation: createUseLiveMutation(useLiveClient),
    useClientQuery: createUseClientQuery(useLiveClient),
    useConnectionStatus: createUseConnectionStatus(useLiveClient),
    usePendingMutations: createUsePendingMutations(useLiveClient),
    usePresence: createUsePresence(useLiveClient),
  };
}
