import { InjectionToken } from '@velajs/vela';
import type { StorageDriver } from './storage.types';
import type { StorageService } from './storage.service';

/** Bucket name used when a registration omits `name`. */
export const DEFAULT_STORAGE_NAME = 'default';

// Tokens are memoized per bucket name so a module's `provide` and a
// consumer's `inject` resolve to the *same* token instance.

const builderTokens = new Map<string, InjectionToken<() => StorageDriver>>();
const serviceTokens = new Map<string, InjectionToken<StorageService>>();

/** Internal token holding the lazy driver-construction thunk for `name`. */
export function storageDriverBuilder(name: string): InjectionToken<() => StorageDriver> {
  let token = builderTokens.get(name);
  if (!token) {
    token = new InjectionToken<() => StorageDriver>(`vela.storage.Builder:${name}`);
    builderTokens.set(name, token);
  }
  return token;
}

/**
 * Token that resolves to the {@link StorageService} for a named bucket.
 * The default bucket uses the `StorageService` class token directly (see
 * `@InjectStorage()`); named buckets use this.
 */
export function storageToken(name: string): InjectionToken<StorageService> {
  let token = serviceTokens.get(name);
  if (!token) {
    token = new InjectionToken<StorageService>(`vela.storage.Service:${name}`);
    serviceTokens.set(name, token);
  }
  return token;
}
