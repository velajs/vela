// Config-namespace registration. Design ported from stratal's `registerAs`
// (MIT, © Temitayo Fadojutimi) and reworked for vela's multi-runtime DI: env
// enters through the namespace's declared typed environment token.
import {
  defineProvider,
  InjectionToken,
  type ProviderDefinition,
  type Token,
  type Type,
} from '../container/types';

/**
 * The result of {@link registerAs}: a namespaced config factory plus the DI
 * token it is provided under.
 */
export interface ConfigNamespace<
  TKey extends string = string,
  TEnv = Record<string, unknown>,
  TConfig extends object = object,
> {
  /** The concrete injection token for this namespace's resolved config. */
  readonly KEY: InjectionToken<TConfig>;
  /** The namespace name (e.g. `'database'`). */
  readonly namespace: TKey;
  /** Factory receiving the ambient env and returning the namespace config. */
  readonly factory: (env: TEnv) => TConfig;
  /** Checked registration injecting the namespace's declared environment token. */
  asProvider(): ProviderDefinition<TConfig>;
}

/** Runtime namespace metadata does not need access to its environment factory. */
export interface AnyConfigNamespace {
  readonly KEY: Token;
  readonly namespace: string;
  asProvider(): ProviderDefinition<object>;
}

/**
 * Create a namespaced configuration factory (NestJS `registerAs` parity).
 *
 * Environment input comes from an explicit typed token; no reader-selected
 * environment type is fabricated from the ambient binding record. Declare a
 * namespace once and import that declaration wherever its KEY is consumed.
 *
 * @example
 * ```ts
 * export const dbConfig = registerAs('database', ENV_TOKEN, (env) => ({
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
  envToken: InjectionToken<TEnv> | Type<TEnv>,
  factory: (env: NoInfer<TEnv>) => TConfig,
): ConfigNamespace<TKey, TEnv, TConfig> {
  const KEY = new InjectionToken<TConfig>(`vela:config:${namespace}`);
  return {
    KEY,
    namespace,
    factory,
    asProvider(): ProviderDefinition<TConfig> {
      return defineProvider(KEY, { useFactory: factory, inject: [envToken] });
    },
  };
}

/**
 * Extract a namespace's config shape from a {@link registerAs} result.
 *
 * @example `type Db = InferConfigType<typeof dbConfig>` → `{ url: string; pool: number }`
 */
export type InferConfigType<T> = T extends { readonly KEY: InjectionToken<infer C> } ? C : never;

/**
 * Zero-codegen typed config shape from a tuple of namespaces — pass as the
 * a type annotation for separately validated aggregate configuration.
 *
 * For typed runtime access prefer resolving each declared namespace's KEY.
 */
export type ConfigType<L extends readonly AnyConfigNamespace[]> = {
  [N in L[number] as N['namespace']]: InferConfigType<N>;
};
