import type { VelaNonceDurableObject } from './nonce.durable-object';
import { MAX_NONCE_BYTES, isCanonicalBoundedText, isValidExpiry } from './nonce-validation';
import type { NonceStore } from '@velajs/vela/security';

const APP_NAMESPACE_PREFIX = 'vela:nonce:v1:';
const MAX_APP_NAMESPACE_BYTES = 128;
/** The generated Workers binding type for {@link VelaNonceDurableObject}. */
export type DurableObjectNonceNamespace = DurableObjectNamespace<VelaNonceDurableObject>;

export interface DurableObjectNonceStoreOptions {
  /**
   * Stable application/environment boundary (for example `billing-api:prod`).
   * Claims are globally single-use inside this namespace and isolated from all
   * other application namespaces. It must be non-empty, canonical, and at most
   * 128 UTF-8 bytes.
   */
  appNamespace: string;

  /**
   * Resolve the Workers Durable Object namespace at claim time. The resolver is
   * intentionally not cached so request-scoped env/binding references stay safe.
   */
  binding: () => DurableObjectNonceNamespace | Promise<DurableObjectNonceNamespace>;
}

/**
 * Strict, cross-isolate {@link NonceStore} backed by one SQLite Durable Object
 * per explicit application namespace.
 *
 * Invalid input, an unavailable/malformed binding, RPC failure, or a malformed
 * RPC result all deny the claim (`false`). Only the literal boolean `true` from
 * the Durable Object is accepted.
 */
export function durableObjectNonceStore(options: DurableObjectNonceStoreOptions): NonceStore {
  if (!options || typeof options !== 'object') {
    throw new TypeError('Durable Object nonce-store options are required');
  }
  if (!isCanonicalBoundedText(options.appNamespace, MAX_APP_NAMESPACE_BYTES)) {
    throw new TypeError(
      `appNamespace must be canonical, non-empty, and at most ${MAX_APP_NAMESPACE_BYTES} UTF-8 bytes`,
    );
  }
  if (typeof options.binding !== 'function') {
    throw new TypeError('A lazy Durable Object namespace binding resolver is required');
  }

  const objectName = `${APP_NAMESPACE_PREFIX}${options.appNamespace}`;

  return {
    async claim(nonce: string, expEpochSeconds: number): Promise<boolean> {
      const now = Math.floor(Date.now() / 1_000);
      if (!isCanonicalBoundedText(nonce, MAX_NONCE_BYTES) || !isValidExpiry(expEpochSeconds, now)) {
        return false;
      }

      try {
        const namespace = await options.binding();

        const id = namespace.idFromName(objectName);
        const stub = namespace.get(id);
        const result = await stub.claim(nonce, expEpochSeconds);
        return result === true;
      } catch {
        return false;
      }
    },
  };
}
