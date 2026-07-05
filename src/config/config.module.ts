import { Container } from '../container/container';
import type { DynamicModule } from '../module/types';
import { defineModule } from '../module/define-module';
import { ConfigService } from './config.service';
import { ConfigStore } from './config.store';
import { CONFIG_OPTIONS } from './config.tokens';
import type { ConfigModuleOptions } from './config.types';
import type { AnyConfigNamespace } from './register-as';

/**
 * Carrier for the namespace `asProvider()` KEY providers ONLY. Split out of
 * ConfigModule and marked `lazy: true` so those factories — which inject
 * `CONFIG_ENV`, live per-request on edge runtimes — never run at bootstrap.
 * ConfigModule itself stays EAGER (see below).
 */
class ConfigNamespacesModule {}

/**
 * Build the lazy sub-module holding one KEY provider per namespace. Its `key`
 * is derived from the owning ConfigModule instance key so multiple ConfigModule
 * instances get distinct sub-module instances (no import-dedup collision).
 */
function namespacesSubModule(load: AnyConfigNamespace[], key: string): DynamicModule {
  return {
    module: ConfigNamespacesModule,
    key: `config-ns:${key}`,
    lazy: true,
    providers: load.map((namespace) => namespace.asProvider()),
    exports: load.map((namespace) => namespace.KEY),
  };
}

// Rebuilt on `defineModule` (the blessed engine — CLAUDE.md: changed modules
// use it). ConfigModule is EAGER: `ConfigService`, `ConfigStore`, and
// `CONFIG_OPTIONS` construct at bootstrap, so a `forRootAsync` async
// `useFactory` resolves in the awaited bootstrap pass and a *synchronous*
// `app.get(ConfigService)` afterwards returns the cached singleton (no drain).
//
// ONLY the namespace `asProvider()` KEY providers are deferred — they move into
// a LAZY sub-module (`ConfigNamespacesModule`) that ConfigModule imports and
// re-exports. Their factories inject `CONFIG_ENV` (live per-request on edge
// runtimes), so construction must not happen at bootstrap. `ConfigStore`
// resolves each KEY through the container on first `get()`; that first
// resolution claims + sync-drains the sub-module (namespace factories are
// synchronous, so the sync seam is safe). `resolveAllInstances` treats the KEY
// tokens as lazy-only (they belong solely to the lazy sub-module) and skips
// them at bootstrap.
const { ConfigurableModuleClass } = defineModule<ConfigModuleOptions>({
  name: 'Config',
  setup: ({ OPTIONS, options, key }) => {
    const load = (options.load ?? []) as AnyConfigNamespace[];
    const { validateSchema } = options;
    return {
      // Lazy sub-module carries the KEY providers; re-exported below so direct
      // `@Inject(ns.KEY)` and `ConfigStore`'s container lookup both reach them.
      imports: load.length > 0 ? [namespacesSubModule(load, key)] : [],
      providers: [
        {
          // Flat config record. `validate` is applied here for the async path;
          // `forRoot` pre-validates eagerly and strips it (see the override).
          provide: CONFIG_OPTIONS,
          useFactory: (opts: ConfigModuleOptions) =>
            opts.validate ? opts.validate(opts.config ?? {}) : (opts.config ?? {}),
          inject: [OPTIONS],
        },
        {
          // Factory-provided so the store closes over the namespace list +
          // schema; it resolves each namespace's KEY lazily via the container.
          provide: ConfigStore,
          useFactory: (container: Container, config: Record<string, unknown>) =>
            new ConfigStore(container, config, load, validateSchema),
          inject: [Container, CONFIG_OPTIONS],
        },
        ConfigService,
      ],
      exports: [ConfigService, ConfigStore, CONFIG_OPTIONS, ...load.map((n) => n.KEY)],
    };
  },
});

export class ConfigModule extends ConfigurableModuleClass {
  /**
   * Preserve (a) per-call generic inference over the flat config record and
   * (b) the eager-validation contract: `validate` runs at call time so bad
   * config fails fast, then is stripped so the derived `CONFIG_OPTIONS`
   * provider is a passthrough (no double validation). `validateSchema` (the
   * merged-config schema) is deferred to first read — its input needs env.
   */
  static forRoot<T extends Record<string, unknown>>(
    options: ConfigModuleOptions<T> & { isGlobal?: boolean; key?: string } = {},
  ): DynamicModule {
    const validatedConfig = options.validate
      ? options.validate(options.config ?? ({} as T))
      : options.config;
    const { validate: _validate, ...rest } = options;
    return super.forRoot({ ...rest, config: validatedConfig } as ConfigModuleOptions & {
      isGlobal?: boolean;
      key?: string;
    });
  }
}
