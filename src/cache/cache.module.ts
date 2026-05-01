import type { ProviderOptions, Type } from '../container/types';
import type { AsyncModuleOptions, DynamicModule } from '../module/types';
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

    const providers: Array<Type | ProviderOptions> = [
      { provide: CACHE_MANAGER, useValue: store },
      { provide: CACHE_MODULE_OPTIONS, useValue: options },
      CacheService,
      CacheInterceptor,
    ];

    if (isGlobal) {
      providers.push({ provide: APP_INTERCEPTOR, useExisting: CacheInterceptor });
    }

    return {
      module: CacheModule,
      providers,
      exports: [CACHE_MANAGER, CACHE_MODULE_OPTIONS, CacheService, CacheInterceptor],
    };
  }

  static forRootAsync(
    options: AsyncModuleOptions<CacheModuleOptions> & { isGlobal?: boolean },
  ): DynamicModule {
    const providers: Array<Type | ProviderOptions> = [
      {
        provide: CACHE_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
      {
        provide: CACHE_MANAGER,
        useFactory: (opts: CacheModuleOptions) =>
          new MemoryCacheStore(opts.ttl ?? 5, opts.max ?? 100),
        inject: [CACHE_MODULE_OPTIONS],
      },
      CacheService,
      CacheInterceptor,
    ];

    if (options.isGlobal) {
      providers.push({ provide: APP_INTERCEPTOR, useExisting: CacheInterceptor });
    }

    return {
      module: CacheModule,
      imports: options.imports ?? [],
      providers,
      exports: [CACHE_MANAGER, CACHE_MODULE_OPTIONS, CacheService, CacheInterceptor],
    };
  }
}
