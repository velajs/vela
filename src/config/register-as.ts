// Config-namespace registration. Design ported from stratal's `registerAs`
// (MIT, © Temitayo Fadojutimi) and reworked for vela's multi-runtime DI: env
// enters through the `CONFIG_ENV` token instead of a Cloudflare-specific one.
import type { InjectionToken, ProviderOptions } from '../container/types';
import { CONFIG_ENV } from './config.tokens';

/**
 * The result of {@link registerAs}: a namespaced config factory plus the DI
 * token it is provided under.
 */
export interface ConfigNamespace<
  TKey extends string = string,
  TEnv = Record<string, unknown>,
  TConfig extends object = object,
> {
  /** Injection token for this namespace's resolved config (`Symbol.for('vela:config:<ns>')`). */
  readonly KEY: InjectionToken<TConfig>;
  /** The namespace name (e.g. `'database'`). */
  readonly namespace: TKey;
  /** Factory receiving the ambient env and returning the namespace config. */
  readonly factory: (env: TEnv) => TConfig;
  /** Provider registration injecting {@link CONFIG_ENV} — spread into a module's providers. */
  asProvider(): ProviderOptions<TConfig>;
}

/** Any config namespace — structural typing for the module `load` list. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyConfigNamespace = ConfigNamespace<string, any, object>;

/**
 * Create a namespaced configuration factory (NestJS `registerAs` parity).
 *
 * The `KEY` is minted with `Symbol.for` so it keeps a stable identity across
 * module re-evaluation (HMR / repeated imports) — a fresh `InjectionToken`
 * would mint a new identity each eval and break dedup. It is typed as
 * `InjectionToken<TConfig>` purely for injection-site DX.
 *
 * @example
 * ```ts
 * export const dbConfig = registerAs('database', (env: Env) => ({
 *   url: env.DATABASE_URL,
 *   pool: 10,
 * }));
 * // ConfigModule.forRoot({ load: [dbConfig] });
 * // cfg.get('database.url');                              // via ConfigService
 * // constructor(@Inject(dbConfig.KEY) db: InferConfigType<typeof dbConfig>) {}
 * ```
 */
export function registerAs<TKey extends string, TEnv, TConfig extends object>(
  namespace: TKey,
  factory: (env: TEnv) => TConfig,
): ConfigNamespace<TKey, TEnv, TConfig> {
  const KEY = Symbol.for(`vela:config:${namespace}`) as unknown as InjectionToken<TConfig>;
  return {
    KEY,
    namespace,
    factory,
    asProvider(): ProviderOptions<TConfig> {
      return { provide: KEY, useFactory: factory, inject: [CONFIG_ENV] };
    },
  };
}

/**
 * Extract a namespace's config shape from a {@link registerAs} result.
 *
 * @example `type Db = InferConfigType<typeof dbConfig>` → `{ url: string; pool: number }`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InferConfigType<T> = T extends ConfigNamespace<string, any, infer C> ? C : never;

/**
 * Zero-codegen typed config shape from a tuple of namespaces — pass as the
 * `ConfigService` generic to type dot-notation reads.
 *
 * @example `ConfigService<ConfigType<[typeof dbConfig, typeof mailConfig]>>`
 */
export type ConfigType<L extends readonly AnyConfigNamespace[]> = {
  [N in L[number] as N['namespace']]: InferConfigType<N>;
};
