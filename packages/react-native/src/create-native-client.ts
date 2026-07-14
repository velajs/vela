import { LiveClient } from '@velajs/client';
import type { LiveContract, MutationStore } from '@velajs/client';
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
 *  - `authToken`, `fetch`, and `WebSocket` pass straight through. The core
 *    already carries the credential as a Bearer header on HTTP mutations and a
 *    `?token=` query param on the live socket — never a `Cookie` — so it is
 *    natively correct for the cookie-jar-less, `Origin`-less native runtime
 *    with zero extra plumbing. The core resolves the global `fetch`/`WebSocket`
 *    when they are omitted.
 *
 * No cross-tab coordination is defaulted: React Native is single-process and
 * has no `BroadcastChannel`.
 */
export function createNativeClient<C extends LiveContract = LiveContract>(
  options: CreateNativeClientOptions,
): LiveClient<C> {
  const { storage, mutationStoreKey, ...rest } = options;

  const mutationStore: MutationStore | undefined =
    rest.mutationStore ??
    (storage === undefined
      ? undefined
      : createAsyncStorageMutationStore({ storage, key: mutationStoreKey }));

  const offline = rest.offline ?? mutationStore !== undefined;

  return new LiveClient<C>({
    ...rest,
    mutationStore,
    offline,
  });
}
