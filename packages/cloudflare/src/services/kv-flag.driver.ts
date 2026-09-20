import type { FeatureFlagDriver, FlagContext } from '@velajs/feature-flags';

export interface KvFlagDriverOptions {
  /** Driver name used for `use(name)` / default-driver selection. Default `"kv"`. */
  name?: string;
  /** Prefix prepended to every flag key before the KV read. Default `""` (none). */
  prefix?: string;
}

/**
 * Cloudflare KV-backed {@link FeatureFlagDriver}. Flags are stored as JSON
 * values under an optional key prefix and read with `get(key, 'json')`. Reads
 * are type-checked against the requested type: a missing key or a value of the
 * wrong JSON type returns the caller's `fallback`. KV has no targeting, so the
 * evaluation context is ignored.
 *
 * The driver stays honest — it does **not** swallow errors. A KV failure (or a
 * `SyntaxError` from a malformed stored value) propagates; the never-throw
 * guarantee lives in `@velajs/feature-flags`'s service layer.
 *
 * Placed like {@link KVCacheStore}: construct it in a wiring factory over a
 * resolved {@link KVNamespace}.
 *
 * ```ts
 * FeatureFlagsModule.forRootAsync({
 *   inject: [ENV],
 *   useFactory: (env: WorkerEnv) => ({ drivers: [new KvFlagDriver(env.CACHE, { prefix: 'flag:' })] }),
 * });
 * ```
 */
export class KvFlagDriver implements FeatureFlagDriver {
  readonly name: string;
  private readonly prefix: string;

  constructor(
    private readonly ns: KVNamespace,
    options: KvFlagDriverOptions = {},
  ) {
    this.name = options.name ?? 'kv';
    this.prefix = options.prefix ?? '';
  }

  getBoolean(key: string, fallback: boolean, _ctx?: FlagContext): Promise<boolean> {
    return this.read(key, fallback, (v) => typeof v === 'boolean');
  }

  getString(key: string, fallback: string, _ctx?: FlagContext): Promise<string> {
    return this.read(key, fallback, (v) => typeof v === 'string');
  }

  getNumber(key: string, fallback: number, _ctx?: FlagContext): Promise<number> {
    return this.read(key, fallback, (v) => typeof v === 'number');
  }

  getObject(key: string, fallback: object, _ctx?: FlagContext): Promise<unknown> {
    return this.read(key, fallback, (v) => typeof v === 'object' && v !== null);
  }

  /**
   * Reads and JSON-parses the (prefixed) key, returning the parsed value only
   * when `matches` accepts its type; otherwise the caller's fallback. A missing
   * key reads as `null` → fallback. Read/parse errors are left to propagate.
   */
  private async read<T>(
    key: string,
    fallback: T,
    matches: (value: unknown) => value is T,
  ): Promise<T> {
    const value = await this.ns.get(this.prefix + key, 'json');
    if (value === null || value === undefined) return fallback;
    return matches(value) ? value : fallback;
  }
}

/** Convenience factory for {@link KvFlagDriver}. */
export function kvFlagDriver(kv: KVNamespace, options?: KvFlagDriverOptions): KvFlagDriver {
  return new KvFlagDriver(kv, options);
}
