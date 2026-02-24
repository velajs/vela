import { METADATA_KEYS } from '../constants';
import { defineMetadata } from '../metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Type, ProviderOptions } from '../container/types';
import type { DynamicModule } from '../module/types';
import { APP_INTERCEPTOR } from '../pipeline/tokens';
import { CacheInterceptor } from './cache.interceptor';
import { CacheService } from './cache.service';
import { MemoryCacheStore } from './cache.store';
import { CACHE_MANAGER, CACHE_MODULE_OPTIONS } from './cache.tokens';
import type { CacheModuleOptions } from './cache.types';

export class CacheModule {
  static forRoot(options: CacheModuleOptions = {}): DynamicModule {
    const { ttl = 5, max = 100, isGlobal = false } = options;
    const store = new MemoryCacheStore(ttl, max);

    const moduleClass = class CacheDynamicModule {} as unknown as Type;
    Object.defineProperty(moduleClass, 'name', { value: 'CacheModule' });
    defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
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

    return {
      module: moduleClass,
      providers,
    };
  }
}
