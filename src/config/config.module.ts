import type { AsyncModuleOptions, DynamicModule } from '../module/types';
import { stableHash } from '../module/stable-hash';
import { ConfigService } from './config.service';
import { CONFIG_OPTIONS } from './config.tokens';
import type { ConfigModuleOptions } from './config.types';

export class ConfigModule {
  static forRoot<T extends Record<string, unknown>>(
    options: ConfigModuleOptions<T> & { key?: string },
  ): DynamicModule {
    const config = options.validate ? options.validate(options.config) : options.config;

    return {
      module: ConfigModule,
      key: options.key ?? stableHash(options.config),
      providers: [
        { provide: CONFIG_OPTIONS, useValue: config },
        ConfigService,
      ],
      exports: [ConfigService, CONFIG_OPTIONS],
      ...(options.isGlobal ? { global: true } : {}),
    };
  }

  static forRootAsync<T extends Record<string, unknown>>(
    options: AsyncModuleOptions<ConfigModuleOptions<T>> & { isGlobal?: boolean; key?: string },
  ): DynamicModule {
    return {
      module: ConfigModule,
      key: options.key ?? stableHash({ inject: options.inject, useFactory: options.useFactory }),
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
