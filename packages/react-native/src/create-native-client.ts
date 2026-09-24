import { LiveClient } from '@velajs/client';
import type { InferLiveContract, LiveQueryDefinition, MutationStore } from '@velajs/client';
import { createAsyncStorageMutationStore } from './async-storage-store';
import type { CreateNativeClientOptions } from './types';

export type { CreateNativeClientOptions } from './types';

/**
 * Construct a {@link LiveClient} tuned for React Native / Expo. A thin wrapper
 * over `new LiveClient(options)` that fills the one thing the browser gets for
 * free and native does not — a durable offline queue — while leaving the whole
 * native auth story to the existing seams:
 *
 *  - `storage` → an AsyncStorage-backed {@link MutationStore}, and `offline`
 *    defaults ON whenever a durable store exists. An explicit `mutationStore`
 *    wins over `storage`; an explicit `offline` (including `false`) wins over
 *    the store-derived default.
 *  - `authToken`, `socketTicket`, `fetch`, and `WebSocket` pass straight
 *    through. HTTP uses the bearer provider; WebSockets use only a short-lived,
 *    room-bound ticket. Durable offline storage additionally requires a stable
 *    non-secret `identity` fingerprint.
 *
 * No cross-tab coordination is defaulted: React Native is single-process and
 * has no `BroadcastChannel`.
 */
export function createNativeClient<const D extends readonly LiveQueryDefinition[]>(
  options: Omit<CreateNativeClientOptions, 'queries'> & { queries: D },
): LiveClient<InferLiveContract<D>>;
export function createNativeClient(options: CreateNativeClientOptions): LiveClient {
  const { storage, mutationStoreKey, ...rest } = options;

  const mutationStore: MutationStore | undefined =
    rest.mutationStore ??
    (storage === undefined
      ? undefined
      : createAsyncStorageMutationStore({ storage, key: mutationStoreKey }));

  const offline = rest.offline ?? mutationStore !== undefined;

  return new LiveClient({
    ...rest,
    mutationStore,
    offline,
  });
}
