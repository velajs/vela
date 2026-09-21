import { StorageError } from '../storage.error';
import type { StorageDriver } from '../storage.types';
import { passthrough, type RawPreservingMiddleware } from './wrap';

export interface FailoverOptions {
  /** Decide whether an error should trigger failover. Default: transient errors. */
  shouldFailover?: (error: unknown) => boolean;
  onFailover?: (info: { from: number; to: number; error: unknown }) => void;
}

function isTransient(error: unknown): boolean {
  return error instanceof StorageError ? error.retryable : true;
}

function intersectCapabilities(chain: StorageDriver[]): Partial<StorageDriver> {
  return {
    supportsRange: chain.every((d) => !!d.supportsRange),
    supportsDelimiter: chain.every((d) => !!d.supportsDelimiter),
    supportsMetadata: chain.every((d) => !!d.supportsMetadata),
    supportsCacheControl: chain.every((d) => !!d.supportsCacheControl),
    supportsServerSideCopy: chain.every((d) => !!d.supportsServerSideCopy),
  };
}

/**
 * Read-failover across a primary + fallbacks. Reads try each driver in order
 * until one succeeds; writes and presigning go to the primary only (avoids
 * partial/divergent writes). Capabilities are the intersection so the facade
 * never routes a feature to a driver that can't serve it.
 */
export function failover(
  fallbacks: StorageDriver[],
  opts: FailoverOptions = {},
): RawPreservingMiddleware {
  const should = opts.shouldFailover ?? isTransient;
  return (primary) => {
    const chain = [primary, ...fallbacks];
    const read = async <T>(fn: (d: StorageDriver) => Promise<T>): Promise<T> => {
      let lastError: unknown;
      for (let i = 0; i < chain.length; i++) {
        try {
          return await fn(chain[i]!);
        } catch (e) {
          lastError = e;
          if (!should(e) || i === chain.length - 1) throw e;
          opts.onFailover?.({ from: i, to: i + 1, error: e });
        }
      }
      throw lastError;
    };
    return passthrough(primary, {
      ...intersectCapabilities(chain),
      download: (k, o) => read((d) => d.download(k, o)),
      head: (k, o) => read((d) => d.head(k, o)),
      exists: (k, o) => read((d) => d.exists(k, o)),
      list: (o) => read((d) => d.list(o)),
    });
  };
}
