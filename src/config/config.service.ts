import { Injectable } from '../container/decorators';
import { Inject } from '../container/decorators';
import { CONFIG_OPTIONS } from './config.tokens';

@Injectable()
export class ConfigService<T extends Record<string, unknown> = Record<string, unknown>> {
  constructor(@Inject(CONFIG_OPTIONS) private readonly config: T) {}

  get<V>(key: string): V | undefined;
  get<V>(key: string, defaultValue: V): V;
  get<V>(key: string, defaultValue?: V): V | undefined {
    const parts = key.split('.');
    let current: unknown = this.config;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return defaultValue;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return (current as V) ?? defaultValue;
  }

  getAll(): T {
    return this.config;
  }
}
