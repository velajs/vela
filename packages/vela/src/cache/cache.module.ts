import { Injectable } from '../container/decorators';
import { DiscoveryService } from '../discovery/discovery.service';
import { Reflector } from '../pipeline/reflector';
import { MetadataRegistry } from '../registry/metadata.registry';
import { CACHE_MODULE_OPTIONS, CACHE_RESPONSE_METADATA } from './cache.tokens';
import { Module } from '../module/decorators';
import { defineModule } from '../module/define-module';
import { CacheInterceptor } from './cache.interceptor';
import { CacheService } from './cache.service';
import type { CacheModuleOptions } from './cache.types';

const { ConfigurableModuleClass } = defineModule<CacheModuleOptions>({
  name: 'Cache',
  optionsToken: CACHE_MODULE_OPTIONS,
  setup: () => ({ global: { interceptors: [CacheInterceptor] } }),
});

@Injectable()
class CacheConfiguration {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly cache: CacheService,
    private readonly reflector: Reflector,
  ) {}
  onApplicationBootstrap(): void {
    const registrations = this.discovery.getRegistrations({ metadataOnly: true, deferLazy: true });
    if (registrations.filter((entry) => entry.metatype === CacheService).length > 1) {
      throw new TypeError('Configure only one CacheModule per application.');
    }
    for (const { metatype } of registrations) {
      for (const route of MetadataRegistry.getRoutes(metatype)) {
        // Read as CacheInterceptor reads each request, inherited declarations
        // included.
        const context = { getClass: () => metatype, getHandlerName: () => route.handlerName };
        const read = (key: string) => this.reflector.getAllAndOverride(key, context);
        const config = read(CACHE_RESPONSE_METADATA);
        if (typeof config !== 'object' || config === null) continue;
        if (
          'tags' in config &&
          Array.isArray(config.tags) &&
          config.tags.length &&
          !this.cache.options.invalidation
        ) {
          throw new TypeError('Cache tags require an invalidation store.');
        }
      }
    }
  }
}

/**
 * The one cache module, asynchronous end to end: a store (memory by default,
 * or `kvCache({ binding })` on Cloudflare) feeds both `@CacheResponse()`
 * routes and the injected `CacheService`. `namespace` and the trusted `scope`
 * resolver are required; configure it once per application with `forRoot` or
 * `forRootAsync`.
 */
@Module({
  providers: [CacheService, CacheConfiguration],
  exports: [CacheService, CacheInterceptor],
})
export class CacheModule extends ConfigurableModuleClass {}
