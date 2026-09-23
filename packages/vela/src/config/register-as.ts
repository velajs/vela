// Config-namespace registration. Design ported from stratal's `registerAs`
// (MIT, © Temitayo Fadojutimi) and reworked for vela's multi-runtime DI: the
// factory reads the application's framework-owned ENV.
import { Container } from '../container/container';
import {
  defineProvider,
  InjectionToken,
  type ProviderDefinition,
  type Token,
} from '../container/types';
import { ENV, type VelaEnv } from '../env';

/**
 * The result of {@link registerAs}: a namespaced config factory plus the DI
 * token it is provided under.
 */
export interface ConfigNamespace<TKey extends string = string, TConfig extends object = object> {
  /** The concrete injection token for this namespace's resolved config. */
  readonly KEY: InjectionToken<TConfig>;
  /** The namespace name (e.g. `'database'`). */
  readonly namespace: TKey;
  /** Factory receiving the application's ENV and returning the namespace config. */
  readonly factory: (env: VelaEnv) => TConfig;
  /** Registration that runs the factory with the application's ENV. */
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
 * The factory receives the application's {@link ENV}, which a runtime seeds
 * (`VelaFactory.create(root, { env })`, a runtime adapter, or
 * `@velajs/cloudflare`). Environment values come from outside the program, so
 * validate each one the factory reads. Reading a namespace in an application
 * without a seeded ENV throws.
 *
 * @example
 * ```ts
 * export const dbConfig = registerAs('database', (env) => ({
 *   url: env.DATABASE_URL,
 *   pool: 10,
 * }));
 * // ConfigModule.forRoot({ load: [dbConfig] }) or ConfigModule.forFeature(dbConfig)
 * // cfg.get('database.url');                              // via ConfigService
 * // constructor(@Inject(dbConfig.KEY) db: ConfigType<typeof dbConfig>) {}
 * ```
 */
export function registerAs<TKey extends string, TConfig extends object>(
  namespace: TKey,
  factory: (env: VelaEnv) => TConfig,
): ConfigNamespace<TKey, TConfig> {
  const KEY = new InjectionToken<TConfig>(`vela:config:${namespace}`);
  return {
    KEY,
    namespace,
    factory,
    asProvider(): ProviderDefinition<TConfig> {
      return defineProvider(KEY, {
        // ENV has no default, so name the namespace instead of surfacing a bare
        // missing-token error from inside the config read.
        useFactory: (container: Container) => {
          if (!container.has(ENV)) {
            throw new Error(
              `registerAs('${namespace}') reads ENV, but no runtime seeded it. Pass \`env\` to ` +
                'VelaFactory.create(), bootstrap() or Test.createTestingModule(), or use a runtime ' +
                'adapter such as @velajs/cloudflare.',
            );
          }
          return factory(container.resolve(ENV));
        },
        inject: [Container],
      });
    },
  };
}

/**
 * The config shape of one {@link registerAs} namespace (NestJS `ConfigType`).
 *
 * @example `constructor(@Inject(dbConfig.KEY) db: ConfigType<typeof dbConfig>)`
 */
export type ConfigType<T extends AnyConfigNamespace> = T extends {
  readonly KEY: InjectionToken<infer C>;
}
  ? C
  : never;

/**
 * The merged config shape of loaded namespaces, keyed by namespace name — the
 * `ConfigService` generic for `ConfigModule.forRoot({ load })`.
 *
 * @example `ConfigService<ConfigShape<[typeof dbConfig, typeof mailConfig]>>`
 */
export type ConfigShape<L extends readonly AnyConfigNamespace[]> = {
  [N in L[number] as N['namespace']]: ConfigType<N>;
};
