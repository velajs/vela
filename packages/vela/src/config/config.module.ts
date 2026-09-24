import { Container } from '../container/container';
import { defineProvider, InjectionToken } from '../container/types';
import type { DynamicModule } from '../module/types';
import type { ModuleRegistrationOptions } from '../module/configurable-module.types';
import { defineModule } from '../module/define-module';
import { attachModuleIdentity } from '../module/module-fingerprints';
import { ConfigService } from './config.service';
import { ConfigStore } from './config.store';
import { CONFIG_OPTIONS } from './config.tokens';
import type { ConfigModuleOptions } from './config.types';
import type { AnyConfigNamespace } from './register-as';

/**
 * Carrier for the namespace `asProvider()` KEY providers ONLY. Split out of
 * ConfigModule and marked `lazy: true` so those factories, which read the
 * application's ENV, run on first read instead of at bootstrap (cold start).
 * ConfigModule itself stays EAGER (see below).
 */
class ConfigNamespacesModule {}

/** Holder for one `ConfigModule.forFeature()` namespace. */
class ConfigFeatureModule {}

/**
 * The lazy sub-module holding ONE namespace's KEY provider. It is keyed by the
 * namespace name, not by the importing module, so `forRoot({ load })` (in any
 * ConfigModule instance) and `forFeature()` of the same namespace collapse
 * into one `(class, key)` instance: the KEY has a single owner, whatever the
 * import path, and its factory runs once. Another namespace object under the
 * same name is reported as a module identity collision.
 */
function namespaceSubModule(namespace: AnyConfigNamespace): DynamicModule {
  return attachModuleIdentity(
    {
      module: ConfigNamespacesModule,
      key: `config-ns:${namespace.namespace}`,
      lazy: true,
      providers: [namespace.asProvider()],
      exports: [namespace.KEY],
    },
    { namespace },
  );
}

// Rebuilt on `defineModule` (the blessed engine — CLAUDE.md: changed modules
// use it). ConfigModule is EAGER: `ConfigService`, `ConfigStore`, and
// `CONFIG_OPTIONS` construct at bootstrap, so a `forRootAsync` async
// `useFactory` resolves in the awaited bootstrap pass and a *synchronous*
// `app.get(ConfigService)` afterwards returns the cached singleton (no drain).
//
// ONLY the namespace `asProvider()` KEY providers are deferred — each moves
// into a LAZY per-namespace sub-module (`ConfigNamespacesModule`) that
// ConfigModule imports and re-exports. Their factories read ENV, and construction waits for the first
// read. `ConfigStore` resolves each KEY through the container on first `get()`;
// that first resolution claims + sync-drains the sub-module (namespace
// factories are synchronous, so the sync seam is safe). `resolveAllInstances`
// treats the KEY tokens as lazy-only (they belong solely to the lazy
// sub-module) and skips them at bootstrap.
const { ConfigurableModuleClass } = defineModule<ConfigModuleOptions, 'load'>({
  name: 'Config',
  structural: ['load'],
  setup: ({ OPTIONS, options }) => {
    const load = options.load ?? [];
    return {
      // Lazy sub-modules carry the KEY providers; re-exported below so direct
      // `@Inject(ns.KEY)` and `ConfigStore`'s container lookup both reach them.
      imports: load.map(namespaceSubModule),
      providers: [
        defineProvider(CONFIG_OPTIONS, {
          // Flat config record. `validate` is applied here for the async path;
          // `forRoot` pre-validates eagerly and strips it (see the override).
          useFactory: (opts) =>
            opts.validate ? opts.validate(opts.config ?? {}) : (opts.config ?? {}),
          inject: [OPTIONS],
        }),
        defineProvider(ConfigStore, {
          // Factory-provided so the store closes over the namespace list; it
          // resolves each namespace's KEY lazily via the container.
          useFactory: (container, config, opts) =>
            new ConfigStore(container, config, load, opts.validateSchema),
          inject: [Container, CONFIG_OPTIONS, OPTIONS],
        }),
        ConfigService,
      ],
      exports: [ConfigService, ConfigStore, CONFIG_OPTIONS, ...load.map((n) => n.KEY)],
    };
  },
});

export class ConfigModule extends ConfigurableModuleClass {
  /**
   * Preserve eager validation: `validate` runs at call time so bad
   * config fails fast, then is stripped so the derived `CONFIG_OPTIONS`
   * provider is a passthrough (no double validation). `validateSchema` (the
   * merged-config schema) is deferred to first read — its input needs env.
   */
  static override forRoot(
    options: ConfigModuleOptions & { isGlobal?: boolean } & ModuleRegistrationOptions = {},
  ): DynamicModule {
    const validatedConfig = options.validate
      ? options.validate(options.config ?? {})
      : options.config;
    const { validate: _validate, ...rest } = options;
    return super.forRoot({ ...rest, config: validatedConfig });
  }

  /**
   * Provide one `registerAs` namespace to the importing module (NestJS
   * `forFeature`): `@Inject(ns.KEY)` resolves there, and a `ConfigModule`
   * store in the application reads it under `ns.namespace`. The factory
   * stays lazy until the first read.
   */
  static forFeature(namespace: AnyConfigNamespace): DynamicModule {
    const registration = new InjectionToken<string>(`vela:config-feature:${namespace.namespace}`);
    // Repeating the same namespace dedupes; another namespace object under the
    // same name is reported as a module identity collision.
    return attachModuleIdentity(
      {
        module: ConfigFeatureModule,
        key: `config-feature:${namespace.namespace}`,
        // Shared with `forRoot({ load })`: one owner for the namespace KEY.
        imports: [namespaceSubModule(namespace)],
        providers: [
          // Merge the namespace into the application's ConfigService at
          // bootstrap. Registering never resolves the KEY, so the factory
          // still waits for its first read.
          defineProvider(registration, {
            useFactory: async (container: Container) => {
              if (container.has(ConfigStore)) {
                (await container.resolveAsync(ConfigStore)).addNamespace(namespace);
              }
              return namespace.namespace;
            },
            inject: [Container],
          }),
        ],
        exports: [namespace.KEY],
      },
      { namespace },
    );
  }
}
