import { Container } from '../container/container';
import type { DynamicModule } from '../module/types';
import { defineModule } from '../module/define-module';
import { ConfigService } from './config.service';
import { ConfigStore } from './config.store';
import { CONFIG_OPTIONS } from './config.tokens';
import type { ConfigModuleOptions } from './config.types';
import type { AnyConfigNamespace } from './register-as';

// Rebuilt on `defineModule` (the blessed engine — CLAUDE.md: changed modules
// use it). `setup()` derives, from the call-time options: one provider per
// namespace (`asProvider()`, injecting CONFIG_ENV), a `CONFIG_OPTIONS` flat
// passthrough (back-compat), the singleton `ConfigStore`, and `ConfigService`.
// Namespaces are NOT resolved here — the store resolves them lazily on first
// read. `forRoot`/`forRootAsync` (with typed `inject`) come from the engine.
const { ConfigurableModuleClass } = defineModule<ConfigModuleOptions>({
  name: 'Config',
  // Deferred so namespace factories never run during bootstrap — env is only
  // live per-request on edge runtimes. First resolution of any config token
  // (an injected `ConfigService`, a request handler, `app.get`) materializes
  // the group. All providers here are synchronous, so the sync seam is safe.
  lazy: true,
  setup: ({ OPTIONS, options }) => {
    const load = (options.load ?? []) as AnyConfigNamespace[];
    const { validateSchema } = options;
    return {
      providers: [
        ...load.map((namespace) => namespace.asProvider()),
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
