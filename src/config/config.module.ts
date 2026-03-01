import { METADATA_KEYS } from '../constants';
import { defineMetadata } from '../metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Type } from '../container/types';
import type { AsyncModuleOptions, DynamicModule } from '../module/types';
import { ConfigService } from './config.service';
import { CONFIG_OPTIONS } from './config.tokens';
import type { ConfigModuleOptions } from './config.types';

export class ConfigModule {
  static forRoot<T extends Record<string, unknown>>(options: ConfigModuleOptions<T>): DynamicModule {
    const config = options.validate ? options.validate(options.config) : options.config;

    const moduleClass = class ConfigDynamicModule {} as unknown as Type;
    Object.defineProperty(moduleClass, 'name', { value: 'ConfigModule' });

    defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
    MetadataRegistry.setModuleOptions(moduleClass, {
      exports: [ConfigService, CONFIG_OPTIONS],
      isGlobal: options.isGlobal,
    });

    return {
      module: moduleClass,
      providers: [
        { provide: CONFIG_OPTIONS, useValue: config },
        ConfigService,
      ],
      ...(options.isGlobal ? { global: true } : {}),
    };
  }

  static forRootAsync<T extends Record<string, unknown>>(
    options: AsyncModuleOptions<ConfigModuleOptions<T>> & { isGlobal?: boolean },
  ): DynamicModule {
    const moduleClass = class ConfigAsyncDynamicModule {} as unknown as Type;
    Object.defineProperty(moduleClass, 'name', { value: 'ConfigModule' });

    defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
    MetadataRegistry.setModuleOptions(moduleClass, {
      imports: options.imports ?? [],
      exports: [ConfigService, CONFIG_OPTIONS],
      isGlobal: options.isGlobal,
    });

    return {
      module: moduleClass,
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
      ...(options.isGlobal ? { global: true } : {}),
    };
  }
}
