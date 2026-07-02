import type { DynamicModule } from '../module/types';
import { Module } from '../module/decorators';
import { ConfigurableModuleBuilder } from '../module/configurable-module.builder';
import { ConfigService } from './config.service';
import { CONFIG_OPTIONS } from './config.tokens';
import type { ConfigModuleOptions } from './config.types';

// MODULE_OPTIONS_TOKEN carries the RAW options; CONFIG_OPTIONS stays the
// distinct validated-record token, derived in @Module. The derived provider
// validates the forRootAsync path lazily (its factory is deferred); forRoot
// validates eagerly at call time (see the override below), matching the
// long-standing contract, and passes an already-validated config through.
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<ConfigModuleOptions>({
  moduleName: 'Config',
}).build();

@Module({
  providers: [
    ConfigService,
    {
      provide: CONFIG_OPTIONS,
      useFactory: (options: ConfigModuleOptions) =>
        options.validate ? options.validate(options.config) : options.config,
      inject: [MODULE_OPTIONS_TOKEN],
    },
  ],
  exports: [ConfigService, CONFIG_OPTIONS],
})
export class ConfigModule extends ConfigurableModuleClass {
  // Preserve (a) per-call generic inference over the config record and (b) the
  // eager-validation contract: forRoot validates at call time so bad config
  // fails fast. `super.forRoot` runs the generated static with `this === ConfigModule`.
  static forRoot<T extends Record<string, unknown>>(
    options: ConfigModuleOptions<T> & { isGlobal?: boolean; key?: string },
  ): DynamicModule {
    const validated = options.validate ? options.validate(options.config) : options.config;
    // Strip `validate` so the derived CONFIG_OPTIONS provider is a passthrough
    // (no double validation) for the already-validated config.
    const { validate: _validate, ...rest } = options;
    return super.forRoot({ ...rest, config: validated } as ConfigModuleOptions & {
      isGlobal?: boolean;
      key?: string;
    });
  }
}
