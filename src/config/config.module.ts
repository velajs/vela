import type { AsyncModuleOptions, DynamicModule } from '../module/types';
import { ConfigService } from './config.service';
import { CONFIG_OPTIONS } from './config.tokens';
import type { ConfigModuleOptions } from './config.types';

export class ConfigModule {
  static forRoot<T extends Record<string, unknown>>(options: ConfigModuleOptions<T>): DynamicModule {
    const config = options.validate ? options.validate(options.config) : options.config;

    return {
      module: ConfigModule,
      providers: [
        { provide: CONFIG_OPTIONS, useValue: config },
        ConfigService,
      ],
      exports: [ConfigService, CONFIG_OPTIONS],
      ...(options.isGlobal ? { global: true } : {}),
    };
  }

  static forRootAsync<T extends Record<string, unknown>>(
    options: AsyncModuleOptions<ConfigModuleOptions<T>> & { isGlobal?: boolean },
  ): DynamicModule {
    return {
      module: ConfigModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: CONFIG_OPTIONS,
          useFactory: async (...args: unknown[]) => {
            const opts = await options.useFactory(...args) as ConfigModuleOptions<T>;
            return opts.validate ? opts.validate(opts.config) : opts.config;
          },
          inject: options.inject ?? [],
        },
        ConfigService,
      ],
      exports: [ConfigService, CONFIG_OPTIONS],
      ...(options.isGlobal ? { global: true } : {}),
    };
  }
}
