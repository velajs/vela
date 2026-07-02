import { Module } from '../module/decorators';
import { ConfigurableModuleBuilder } from '../module/configurable-module.builder';
import { APP_INTERCEPTOR } from '../pipeline/tokens';
import { CacheInterceptor } from './cache.interceptor';
import { CacheService } from './cache.service';
import { MemoryCacheStore } from './cache.store';
import { CACHE_MANAGER, CACHE_MODULE_OPTIONS } from './cache.tokens';
import type { CacheModuleOptions } from './cache.types';

// Reuse the public CACHE_MODULE_OPTIONS token so its identity (and the
// index.ts export) is unchanged. `isGlobal` here means "register the interceptor
// globally as APP_INTERCEPTOR" — NOT `DynamicModule.global` — so the extras
// transform is customized rather than using the default isGlobal→global.
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<CacheModuleOptions>({
  moduleName: 'Cache',
  optionsInjectionToken: CACHE_MODULE_OPTIONS,
})
  .setExtras({ isGlobal: false }, (definition, { isGlobal }) =>
    isGlobal
      ? {
          ...definition,
          providers: [
            ...(definition.providers ?? []),
            { provide: APP_INTERCEPTOR, useExisting: CacheInterceptor },
          ],
        }
      : definition,
  )
  .build();

@Module({
  providers: [
    CacheService,
    CacheInterceptor,
    // One options-injecting provider serves BOTH forRoot and forRootAsync.
    // A custom `store` (e.g. TieredCacheStore / KVCacheStore) overrides the
    // default in-memory store.
    {
      provide: CACHE_MANAGER,
      useFactory: (options: CacheModuleOptions) =>
        options.store ?? new MemoryCacheStore(options.ttl ?? 5, options.max ?? 100),
      inject: [MODULE_OPTIONS_TOKEN],
    },
  ],
  exports: [CACHE_MANAGER, CACHE_MODULE_OPTIONS, CacheService, CacheInterceptor],
})
export class CacheModule extends ConfigurableModuleClass {}
