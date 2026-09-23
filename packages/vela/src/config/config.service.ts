import { Injectable, Inject } from '../container/decorators';
import { ConfigStore } from './config.store';
import type { ConfigPath, ConfigPathValue } from './config.types';

// A service without a declared shape (`object`, as a bare `ConfigService`
// class token infers) accepts any path and reads `unknown`.
type ServicePath<T> = [keyof T] extends [never] ? string : ConfigPath<T>;
type ServiceValue<T, P extends string> = [keyof T] extends [never]
  ? unknown
  : ConfigPathValue<T, P>;
/** The value at a path once presence is proven. */
type PresentValue<T, P extends string> = Exclude<ServiceValue<T, P>, undefined>;

/**
 * Dot-path reads over the loaded config: the flat `config` record merged with
 * the `registerAs` namespaces. `T` describes that shape, for example
 * `ConfigService<ConfigShape<[typeof dbConfig]>>` in a constructor; paths and
 * values are then checked against it. Without `T`, every read is `unknown`
 * until a schema validates it (see {@link ConfigService.parse}).
 */
@Injectable()
export class ConfigService<T extends object = Record<string, unknown>> {
  constructor(@Inject(ConfigStore) private readonly store: ConfigStore) {}

  get<P extends ServicePath<T>>(path: P): ServiceValue<T, P> | undefined;
  get<P extends ServicePath<T>>(
    path: P,
    defaultValue: NoInfer<PresentValue<T, P>>,
  ): PresentValue<T, P>;
  get(path: string, defaultValue?: unknown): unknown {
    const value = this.store.get(path);
    return value === undefined ? defaultValue : value;
  }

  getOrThrow<P extends ServicePath<T>>(path: P): PresentValue<T, P>;
  getOrThrow(path: string): unknown {
    return this.store.getOrThrow(path);
  }

  /** Parse a config value at an explicit validation boundary. */
  parse<R>(path: string, schema: { parse(value: unknown): R }): R {
    return schema.parse(this.store.get(path));
  }

  has(path: string): boolean {
    return this.store.has(path);
  }

  getAll(): T;
  getAll(): object {
    return this.store.all();
  }
}
