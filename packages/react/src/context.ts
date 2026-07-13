import { createContext, createElement, useContext } from 'react';
import type { ReactNode } from 'react';
import type { LiveClient } from '@velajs/client';
import type { LiveContract } from '@velajs/client';

// Deliberately `any`-typed inside the context: the contract generic is
// re-applied at the useLiveClient() boundary. One provider serves any app.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LiveClientContext = createContext<LiveClient<any> | null>(null);

export interface LiveProviderProps {
  client: LiveClient<LiveContract>;
  children?: ReactNode;
}

/** Provides the LiveClient to the hook tree. `createElement`-based — no JSX toolchain required. */
export function LiveProvider(props: LiveProviderProps): ReturnType<typeof createElement> {
  return createElement(LiveClientContext.Provider, { value: props.client }, props.children);
}

export function useLiveClient<C extends LiveContract = LiveContract>(): LiveClient<C> {
  const client = useContext(LiveClientContext);
  if (!client) {
    throw new Error(
      'useLiveClient: no LiveClient in context — wrap the tree in <LiveProvider client={…}>.',
    );
  }
  return client as LiveClient<C>;
}
