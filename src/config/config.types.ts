import type { AnyConfigNamespace } from './register-as';

/**
 * A schema for validating the fully-merged config. Kept structural so zod stays
 * an OPTIONAL peer — a zod schema (has `.parse`) or a plain function both work;
 * core never imports zod. Throwing rejects the config.
 */
export type ConfigSchema =
  | ((config: Record<string, unknown>) => unknown)
  | { parse: (config: unknown) => unknown };

/**
 * Options for {@link ConfigModule}.
 *
 * NOTE: `load` and `validateSchema` are **`forRoot`-only** — they are read
 * structurally from the call-time options bag. On the `forRootAsync` path the
 * options come from a DI-resolved factory, so only the flat `config` record is
 * supported there (async namespaces are out of scope; declare them via
 * `forRoot`).
 */
export interface ConfigModuleOptions<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Flat config record — the pre-namespace `config` path (still supported). */
  config?: T;
  /** Config namespaces created via `registerAs()`, merged under their namespace name. `forRoot`-only. */
  load?: AnyConfigNamespace[];
  /** Eager validator for the flat `config` record; runs at `forRoot()` call time. */
  validate?: (config: T) => T;
  /** Schema validating the MERGED config (flat + namespaces); runs lazily on first read. `forRoot`-only. */
  validateSchema?: ConfigSchema;
  isGlobal?: boolean;
}

/**
 * All valid dot-notation paths of a config object type.
 * @example `ConfigPath<{ database: { url: string } }>` → `'database' | 'database.url'`
 */
export type ConfigPath<T> = {
  [K in keyof T & string]: T[K] extends Record<string, unknown>
    ? K | `${K}.${ConfigPath<T[K]>}`
    : K;
}[keyof T & string];

/**
 * The value type at a dot-notation path.
 * @example `ConfigPathValue<{ database: { url: string } }, 'database.url'>` → `string`
 */
export type ConfigPathValue<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? T[K] extends Record<string, unknown>
      ? ConfigPathValue<T[K], Rest>
      : never
    : never
  : P extends keyof T
    ? T[P]
    : never;
