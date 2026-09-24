import { Module } from '../module/decorators';
import { defineProvider } from '../container/types';
import { defineModule } from '../module/define-module';
import { APP_INTERCEPTOR } from '../pipeline/tokens';
import { CacheInterceptor } from './cache.interceptor';
import { CacheService } from './cache.service';
import { MemoryCacheStore } from './cache.store';
import { CACHE_MANAGER, CACHE_MODULE_OPTIONS } from './cache.tokens';
import type { CacheModuleOptions } from './cache.types';

// Reuse the public CACHE_MODULE_OPTIONS token so its identity (and the
// index.ts export) is unchanged. `globalInterceptor` is structural: it decides
// whether the module registers CacheInterceptor as an APP_INTERCEPTOR.
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<
  CacheModuleOptions,
  'globalInterceptor'
>({
  name: 'Cache',
  optionsToken: CACHE_MODULE_OPTIONS,
  structural: ['globalInterceptor'],
  defaults: { globalInterceptor: false },
  setup: ({ options }) => ({
    // CacheInterceptor itself is a provider of the @Module bag below.
    providers: options.globalInterceptor
      ? [defineProvider(APP_INTERCEPTOR, { useExisting: CacheInterceptor })]
      : [],
  }),
});

@Module({
  providers: [
    CacheService,
    CacheInterceptor,
    // One options-injecting provider serves BOTH forRoot and forRootAsync.
    // A custom synchronous store overrides the default memory store. Async
    // stores belong to the separate ResponseCacheModule authoring path.
    defineProvider(CACHE_MANAGER, {
      useFactory: (options) =>
        options.store ?? new MemoryCacheStore(options.ttl ?? 5, options.max ?? 100),
      inject: [MODULE_OPTIONS_TOKEN],
    }),
  ],
  exports: [CACHE_MANAGER, CACHE_MODULE_OPTIONS, CacheService, CacheInterceptor],
})
export class CacheModule extends ConfigurableModuleClass {}
