import { InjectionToken } from '../index';
import type { QueueClient } from './queue.client';
import type { QueueDriver } from './queue.types';

export const PROCESSOR_METADATA = 'vela:queue:processor';
export const PROCESS_METADATA = 'vela:queue:process';

/** The driver in effect for a `QueueModule` instance. */
export const QUEUE_DRIVER = new InjectionToken<QueueDriver>('vela:queue:driver');

// Token identity must survive Vite HMR re-evals (a consumer module that was
// NOT re-evaluated still holds the token minted by the previous generation),
// so the name → token map is anchored on globalThis exactly like the
// entrypoint kind store and MetadataRegistry state.
const TOKEN_STORE_KEY = Symbol.for('vela:queue:client-tokens:v1');

function tokenStore(): Map<string, InjectionToken<QueueClient>> {
  const g = globalThis as unknown as Record<
    symbol,
    Map<string, InjectionToken<QueueClient>> | undefined
  >;
  return (g[TOKEN_STORE_KEY] ??= new Map());
}

/**
 * The injection token for a named queue's `QueueClient`:
 *
 * ```ts
 * constructor(@Inject(queueToken('email')) private readonly email: QueueClient) {}
 * ```
 *
 * Memoized per name (HMR-stable). Deliberately NO `InjectionToken` default
 * factory: the container resolves default-factory tokens from the root bucket
 * BEFORE walking module imports, which would break the exported-provider
 * path — the token description (`vela:queue:client:<name>`) keeps the
 * no-provider error readable instead.
 */
export function queueToken(name: string): InjectionToken<QueueClient> {
  const store = tokenStore();
  let token = store.get(name);
  if (!token) {
    token = new InjectionToken<QueueClient>(`vela:queue:client:${name}`);
    store.set(name, token);
  }
  return token;
}
