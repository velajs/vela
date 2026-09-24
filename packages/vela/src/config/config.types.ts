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
 * `load` is structural: it decides which namespace providers the module
 * registers, so `forRootAsync` takes it alongside the factory, which returns
 * the other options.
 */
export interface ConfigModuleOptions {
  /** Flat config record — the pre-namespace `config` path (still supported). */
  config?: Record<string, unknown>;
  /** Config namespaces created via `registerAs()`, merged under their namespace name. Structural. */
  load?: AnyConfigNamespace[];
  /** Validator for the flat `config` record; `forRoot` runs it at call time. */
  validate?: (config: Record<string, unknown>) => Record<string, unknown>;
  /** Schema validating the MERGED config (flat + namespaces); runs lazily on first read. */
  validateSchema?: ConfigSchema;
}

/**
 * All valid dot-notation paths of a config object type, expanded at most
 * `Depth` levels below the first so recursive shapes stay cheap to check.
 * @example `ConfigPath<{ database: { url: string } }>` → `'database' | 'database.url'`
 */
export type ConfigPath<T, Depth extends number = 8> = [Depth] extends [never]
  ? never
  : {
      [K in keyof T & string]: [ConfigBranch<T[K]>] extends [never]
        ? K
        : K | `${K}.${ConfigPath<ConfigBranch<T[K]>, PreviousDepth[Depth]>}`;
    }[keyof T & string];

/**
 * The value type at a dot-notation path. Segments below an `unknown` value
 * stay `unknown`, so an untyped record reads as `unknown` at any path.
 * @example `ConfigPathValue<{ database: { url: string } }, 'database.url'>` → `string`
 */
export type ConfigPathValue<T, P extends string> = P extends keyof T
  ? T[P]
  : P extends `${infer K}.${infer Rest}`
    ? K extends keyof T
      ? unknown extends T[K]
        ? unknown
        : ConfigPathValue<NonNullable<T[K]>, Rest> | (undefined extends T[K] ? undefined : never)
      : never
    : never;

/** Remaining path depth per segment; caps the recursion of self-referential shapes. */
type PreviousDepth = [never, 0, 1, 2, 3, 4, 5, 6, 7];

/** A value whose keys continue a path. Arrays and functions are leaves. */
type ConfigBranch<V> = V extends readonly unknown[] | ((...args: never[]) => unknown)
  ? never
  : V extends object
    ? V
    : never;
