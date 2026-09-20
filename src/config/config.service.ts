import { Injectable, Inject } from '../container/decorators';
import { ConfigStore } from './config.store';

/** Runtime config reads are unknown until a schema validates them. For an already
 * typed namespace, inject or resolve its declared namespace.KEY token. */
@Injectable()
export class ConfigService {
  constructor(@Inject(ConfigStore) private readonly store: ConfigStore) {}

  get(path: string, defaultValue?: unknown): unknown {
    const value = this.store.get(path);
    return value === undefined ? defaultValue : value;
  }

  getOrThrow(path: string): unknown {
    return this.store.getOrThrow(path);
  }

  /** Parse a config value at an explicit validation boundary. */
  parse<T>(path: string, schema: { parse(value: unknown): T }): T {
    return schema.parse(this.store.get(path));
  }

  has(path: string): boolean {
    return this.store.has(path);
  }

  getAll(): Record<string, unknown> {
    return this.store.all();
  }
}
