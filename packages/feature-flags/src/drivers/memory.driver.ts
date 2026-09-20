import type { FeatureFlagDriver } from './driver';
import type { FlagContext, FlagManifest, FlagValue } from '../feature-flags.types';

export interface MemoryFlagDriverOptions {
  /** Driver name used for `use(name)` / the default-driver selection. Default `"memory"`. */
  name?: string;
  /** Initial flag values. */
  values?: FlagManifest;
}

/**
 * In-memory {@link FeatureFlagDriver}: the default driver shipped in-package
 * and the test fake in one. Reads from an internal `Map` seeded from options
 * or mutated with {@link set}/{@link reset} — the memory driver ignores the
 * evaluation context (it does no targeting). An unknown key returns the
 * caller's `fallback`, exactly like a remote driver that can't resolve it.
 */
export class MemoryFlagDriver implements FeatureFlagDriver {
  readonly name: string;
  private readonly store: Map<string, FlagValue>;

  constructor(options: MemoryFlagDriverOptions = {}) {
    this.name = options.name ?? 'memory';
    this.store = new Map(Object.entries(options.values ?? {}));
  }

  /** Set a flag value. Chainable. */
  set(key: string, value: FlagValue): this {
    this.store.set(key, value);
    return this;
  }

  /** Remove a flag (subsequent reads return the caller's fallback). Chainable. */
  delete(key: string): this {
    this.store.delete(key);
    return this;
  }

  /** True when `key` has a stored value. */
  has(key: string): boolean {
    return this.store.has(key);
  }

  /** Clear all flags, then optionally seed a fresh set. Chainable. */
  reset(values?: FlagManifest): this {
    this.store.clear();
    if (values) {
      for (const [key, value] of Object.entries(values)) this.store.set(key, value);
    }
    return this;
  }

  getBoolean(key: string, fallback: boolean, _ctx?: FlagContext): Promise<boolean> {
    const value = this.store.get(key);
    return Promise.resolve(typeof value === 'boolean' ? value : fallback);
  }

  getString(key: string, fallback: string, _ctx?: FlagContext): Promise<string> {
    const value = this.store.get(key);
    return Promise.resolve(typeof value === 'string' ? value : fallback);
  }

  getNumber(key: string, fallback: number, _ctx?: FlagContext): Promise<number> {
    const value = this.store.get(key);
    return Promise.resolve(typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  }

  getObject(key: string, fallback: object, _ctx?: FlagContext): Promise<unknown> {
    const value = this.store.get(key);
    return Promise.resolve(typeof value === 'object' && value !== null ? value : fallback);
  }
}

/** Convenience factory for {@link MemoryFlagDriver}. */
export function memoryFlagDriver(options?: MemoryFlagDriverOptions): MemoryFlagDriver {
  return new MemoryFlagDriver(options);
}
