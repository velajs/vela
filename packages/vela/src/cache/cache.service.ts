import { Container } from '../container/container';
import { Injectable, Inject, Optional } from '../container/decorators';
import { sha256Base64Url } from '../crypto/hmac';
import { InjectEnv, type VelaEnv } from '../env';
import { resolveErrorReporter } from '../exceptions/reporter';
import { MemoryCacheStore } from './cache.store';
import { CACHE_MODULE_OPTIONS } from './cache.tokens';
import type {
  CacheEntryOptions,
  CacheInvalidationResult,
  CacheModuleOptions,
  CacheScope,
  ResolvedCacheOptions,
  ScopedCache,
} from './cache.types';
import {
  snapshot,
  validateEntryOptions,
  validateLabel,
  validateOptions,
  validateScope,
} from './cache.validation';

type StoredEntry = {
  version: 1;
  expiresAt: number;
  payload: string;
  tags: string[];
  generations: string[];
};
const hash = (parts: readonly string[]) =>
  sha256Base64Url(new TextEncoder().encode(JSON.stringify(parts)));

const EMPTY_ENV: VelaEnv = Object.freeze({});

/**
 * The module's stores for one application: a store or invalidation given as a
 * function is built from that application's ENV, and no store means a fresh
 * in-memory one.
 */
function resolveOptions(options: CacheModuleOptions, env: VelaEnv): ResolvedCacheOptions {
  const { store, invalidation, ...rest } = options;
  const resolved: ResolvedCacheOptions = {
    ...rest,
    store:
      typeof store === 'function'
        ? store(env)
        : (store ?? new MemoryCacheStore(options.ttl ?? 30, options.max ?? 1000)),
  };
  const generations = typeof invalidation === 'function' ? invalidation(env) : invalidation;
  if (generations !== undefined) resolved.invalidation = generations;
  return resolved;
}

/**
 * The one cache service: scoped values and post-commit invalidation over the
 * module's store. `@CacheResponse()` routes share the same store and scopes.
 */
@Injectable()
export class CacheService {
  readonly options: Readonly<ResolvedCacheOptions>;
  constructor(
    @Inject(CACHE_MODULE_OPTIONS) options: CacheModuleOptions,
    @Optional() @InjectEnv() env?: VelaEnv,
    @Optional() @Inject(Container) private readonly container?: Container,
  ) {
    validateLabel(options.namespace, 'Cache namespace');
    const resolved = resolveOptions(options, env ?? EMPTY_ENV);
    validateOptions(resolved);
    this.options = Object.freeze(resolved);
  }

  /** Call with the same trusted scope used by the route resolver. Handles cannot change partition. */
  scope(scope: CacheScope): ScopedCache {
    validateScope(scope);
    return this.scoped(scope, 'service');
  }

  /** @internal Separate key space prevents programmatic keys from replacing route responses. */
  scoped(scope: CacheScope, domain: 'service' | 'http'): ScopedCache {
    validateScope(scope);
    const prefix = hash([this.options.namespace, scope.visibility, scope.partition]);
    const address = async (key: string) => {
      validateLabel(key, 'Cache key');
      return `vela:response:v1:${await prefix}:${await hash([domain, key])}`;
    };
    const generations = async (key: string, tags: readonly string[]): Promise<string[]> => {
      const store = this.options.invalidation;
      if (!store) return [];
      const root = `vela:response:v1:${await prefix}`;
      const ids = [
        root,
        `${root}:key:${await hash([domain, key])}`,
        ...(await Promise.all(tags.map(async (tag) => `${root}:tag:${await hash([tag])}`))),
      ];
      return Promise.all(
        ids.map(async (id) => {
          const version = await store.getVersion(id);
          validateLabel(version, 'Cache generation');
          return version;
        }),
      );
    };
    const normalize = (options: CacheEntryOptions = {}) => {
      validateEntryOptions(options);
      if (options.tags?.length && !this.options.invalidation)
        throw new TypeError('Cache tags require an invalidation store.');
      return {
        ttl: options.ttl ?? this.options.ttl ?? 30,
        tags: [...new Set(options.tags ?? [])].sort(),
      };
    };
    const read = async (key: string): Promise<unknown> => {
      const raw = await this.options.store.get(await address(key));
      // Copy/validate untrusted store output before accessing fields or parsing its payload.
      const encoded = snapshot(raw, (this.options.maxBytes ?? 65536) * 6 + 16384);
      if (encoded === undefined) return undefined;
      const entry: unknown = JSON.parse(encoded);
      if (!isEntry(entry) || entry.expiresAt <= Date.now()) return undefined;
      validateEntryOptions({ tags: entry.tags });
      if (entry.tags.length && !this.options.invalidation) return undefined;
      const current = await generations(key, entry.tags);
      if (!same(current, entry.generations) || entry.expiresAt <= Date.now()) return undefined;
      const value: unknown = JSON.parse(entry.payload);
      if (!this.accept(value)) return undefined;
      return value;
    };
    const write = async (
      key: string,
      value: unknown,
      ttl: number,
      tags: string[],
      expected: string[],
    ): Promise<boolean> => {
      const payload = this.accept(value);
      if (ttl === 0 || payload === undefined) return false;
      if (!same(expected, await generations(key, tags))) return false;
      const entry: StoredEntry = {
        version: 1,
        payload,
        expiresAt: Date.now() + ttl * 1000,
        tags,
        generations: expected,
      };
      await this.options.store.set(await address(key), entry, ttl);
      // A later invalidation still makes this entry unreadable, including when a write completes late.
      return same(expected, await generations(key, tags));
    };
    const invalidate = async (
      kind: 'all' | 'key' | 'tags',
      labels: readonly string[],
    ): Promise<CacheInvalidationResult> => {
      if (!this.options.invalidation) return { ok: false, reason: 'unsupported' };
      try {
        if (kind === 'tags') validateEntryOptions({ tags: labels });
        else for (const label of labels) validateLabel(label, 'Cache key');
      } catch {
        return { ok: false, reason: 'invalid-input' };
      }
      try {
        const root = `vela:response:v1:${await prefix}`;
        const ids =
          kind === 'all'
            ? [root]
            : await Promise.all(
                [...new Set(labels)].map(async (label) =>
                  kind === 'key'
                    ? `${root}:key:${await hash([domain, label])}`
                    : `${root}:tag:${await hash([label])}`,
                ),
              );
        const results = await Promise.allSettled(
          ids.map(async (id) => this.options.invalidation!.invalidate(id)),
        );
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        return { ok: true };
      } catch (error) {
        this.report('invalidate', error);
        return { ok: false, reason: 'store-error' };
      }
    };
    const api: ScopedCache = {
      get: async (key) => {
        validateLabel(key, 'Cache key');
        try {
          return await read(key);
        } catch (error) {
          this.report('read', error);
          return undefined;
        }
      },
      getParsed: async (key, parse) => {
        const value = await api.get(key);
        return value === undefined ? undefined : parse(value);
      },
      set: async (key, value, options) => {
        validateLabel(key, 'Cache key');
        const { ttl, tags } = normalize(options);
        try {
          return await write(key, value, ttl, tags, await generations(key, tags));
        } catch (error) {
          this.report('write', error);
          return false;
        }
      },
      remember: async (key, load, options) => {
        validateLabel(key, 'Cache key');
        const { ttl, tags } = normalize(options);
        if (ttl === 0) return load();
        let expected: string[];
        try {
          expected = await generations(key, tags);
          const cached = await read(key);
          if (cached !== undefined) return cached;
        } catch (error) {
          this.report('read', error);
          return load();
        }
        // Handler errors propagate unchanged. Only cache failures are swallowed.
        const value = await load();
        try {
          await write(key, value, ttl, tags, expected);
        } catch (error) {
          this.report('write', error);
        }
        return value;
      },
      invalidateKey: (key) => invalidate('key', [key]),
      invalidateTags: (tags) => invalidate('tags', tags),
      invalidateAll: () => invalidate('all', []),
    };
    return Object.freeze(api);
  }

  /**
   * @internal A failure the cache absorbs as a miss or a false outcome still
   * reaches the application's error reporter, so a missing store binding or
   * an unreachable store is never silent, and then `onError`.
   */
  report(operation: 'read' | 'write' | 'invalidate' | 'scope', error: unknown): void {
    try {
      if (this.container) {
        resolveErrorReporter(this.container).report(error, { edge: 'cache', source: operation });
      }
    } catch {
      /* Diagnostics never change response/write outcomes. */
    }
    try {
      this.options.onError?.(operation, error);
    } catch {
      /* Diagnostics never change response/write outcomes. */
    }
  }

  private accept(value: unknown): string | undefined {
    const json = snapshot(value, this.options.maxBytes ?? 65536);
    if (
      json === undefined ||
      (this.options.shouldCache && this.options.shouldCache(JSON.parse(json)) !== true)
    )
      return undefined;
    return json;
  }
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((version, index) => version === b[index]);
}
function isEntry(value: unknown): value is StoredEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 1 &&
    'expiresAt' in value &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    'payload' in value &&
    typeof value.payload === 'string' &&
    'tags' in value &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string') &&
    'generations' in value &&
    Array.isArray(value.generations) &&
    value.generations.length <= 34 &&
    value.generations.every((version) => typeof version === 'string')
  );
}
