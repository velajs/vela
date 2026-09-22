import { Injectable } from '../container/decorators';
import { DiscoveryService } from '../discovery/discovery.service';
import { MetadataRegistry } from '../registry/metadata.registry';
import { CACHEABLE_METADATA, RESPONSE_CACHE_METADATA } from './cache.tokens';
import { Module } from '../module/decorators';
import { defineModule } from '../module/define-module';
import { ResponseCacheInterceptor } from './response-cache.interceptor';
import { RESPONSE_CACHE_OPTIONS, ResponseCacheService } from './response-cache.service';
import type { ResponseCacheOptions } from './response-cache.types';

const { ConfigurableModuleClass } = defineModule<ResponseCacheOptions>({
  name: 'ResponseCache',
  optionsToken: RESPONSE_CACHE_OPTIONS,
  setup: () => ({ global: { interceptors: [ResponseCacheInterceptor] } }),
});

@Injectable()
class ResponseCacheConfiguration {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly cache: ResponseCacheService,
  ) {}
  onApplicationBootstrap(): void {
    const registrations = this.discovery.getRegistrations({ metadataOnly: true, deferLazy: true });
    if (registrations.filter((entry) => entry.metatype === ResponseCacheService).length > 1) {
      throw new TypeError('Configure only one ResponseCacheModule per application.');
    }
    for (const { metatype } of registrations) {
      for (const route of MetadataRegistry.getRoutes(metatype)) {
        const read = (key: string) =>
          MetadataRegistry.getCustomHandlerMeta(metatype, route.handlerName, key) ??
          MetadataRegistry.getCustomClassMeta(metatype, key);
        const config = read(RESPONSE_CACHE_METADATA);
        if (typeof config !== 'object' || config === null) continue;
        if (read(CACHEABLE_METADATA) === true)
          throw new TypeError('Use only @CacheResponse on async response-cache routes.');
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

/** One configured store feeds both @CacheResponse and injected scoped services. */
@Module({
  providers: [ResponseCacheService, ResponseCacheConfiguration],
  exports: [ResponseCacheService, ResponseCacheInterceptor],
})
export class ResponseCacheModule extends ConfigurableModuleClass {}
