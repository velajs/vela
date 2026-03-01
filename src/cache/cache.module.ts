import { METADATA_KEYS } from '../constants';
import { defineMetadata } from '../metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Type, ProviderOptions } from '../container/types';
import type { AsyncModuleOptions, DynamicModule } from '../module/types';
import { APP_INTERCEPTOR } from '../pipeline/tokens';
import { CacheInterceptor } from './cache.interceptor';
import { CacheService } from './cache.service';
import { MemoryCacheStore } from './cache.store';
import { CACHE_MANAGER, CACHE_MODULE_OPTIONS } from './cache.tokens';
import type { CacheModuleOptions } from './cache.types';

function makeCacheModuleClass(name: string) {
  const moduleClass = class {} as unknown as Type;
  Object.defineProperty(moduleClass, 'name', { value: name });
  defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
  return moduleClass;
}

export class CacheModule {
  static forRoot(options: CacheModuleOptions = {}): DynamicModule {
    const { ttl = 5, max = 100, isGlobal = false } = options;
    const store = new MemoryCacheStore(ttl, max);

    const moduleClass = makeCacheModuleClass('CacheModule');
    MetadataRegistry.setModuleOptions(moduleClass, {
      exports: [CACHE_MANAGER, CACHE_MODULE_OPTIONS, CacheService, CacheInterceptor],
    });

    const providers: Array<Type | ProviderOptions> = [
      { token: CACHE_MANAGER, useValue: store },
      { token: CACHE_MODULE_OPTIONS, useValue: options },
      CacheService,
      CacheInterceptor,
    ];

    if (isGlobal) {
      providers.push({ token: APP_INTERCEPTOR, useExisting: CacheInterceptor });
    }

    return { module: moduleClass, providers };
  }

  static registerAsync(
    options: AsyncModuleOptions<CacheModuleOptions> & { isGlobal?: boolean },
  ): DynamicModule {
    const moduleClass = makeCacheModuleClass('CacheModule');
    MetadataRegistry.setModuleOptions(moduleClass, {
      imports: options.imports ?? [],
      exports: [CACHE_MANAGER, CACHE_MODULE_OPTIONS, CacheService, CacheInterceptor],
    });

    const providers: Array<Type | ProviderOptions> = [
      {
        token: CACHE_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
      {
        token: CACHE_MANAGER,
        useFactory: (opts: CacheModuleOptions) =>
          new MemoryCacheStore(opts.ttl ?? 5, opts.max ?? 100),
        inject: [CACHE_MODULE_OPTIONS],
      },
      CacheService,
      CacheInterceptor,
    ];

    if (options.isGlobal) {
      providers.push({ token: APP_INTERCEPTOR, useExisting: CacheInterceptor });
    }

    return { module: moduleClass, providers };
  }
}
