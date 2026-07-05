import { Injectable, Inject } from '../container/decorators';
import { ConfigStore } from './config.store';
import type { ConfigPath, ConfigPathValue } from './config.types';

/**
 * Typed, dot-notation reads over the merged config. Stays a singleton (NestJS
 * parity); delegates to the {@link ConfigStore}. Pass `ConfigType<[...]>` as the
 * generic to type namespaced paths (`cfg.get('database.url')` → `string`).
 */
@Injectable()
export class ConfigService<T extends Record<string, unknown> = Record<string, unknown>> {
  constructor(@Inject(ConfigStore) private readonly store: ConfigStore) {}

  /** Read a config value; `undefined` when absent, or the supplied default. */
  get<P extends ConfigPath<T>>(path: P): ConfigPathValue<T, P> | undefined;
  get<P extends ConfigPath<T>>(path: P, defaultValue: ConfigPathValue<T, P>): ConfigPathValue<T, P>;
  get(path: string, defaultValue?: unknown): unknown {
    const value = this.store.get(path);
    return value === undefined ? defaultValue : value;
  }

  /** Read a config value; throws when the path is absent. */
  getOrThrow<P extends ConfigPath<T>>(path: P): ConfigPathValue<T, P> {
    return this.store.getOrThrow(path) as ConfigPathValue<T, P>;
  }

  /** Whether a config path resolves to a defined value. */
  has<P extends ConfigPath<T>>(path: P): boolean {
    return this.store.has(path);
  }

  /** The full merged config object (flat record + resolved namespaces). */
  getAll(): T {
    return this.store.all() as T;
  }
}
