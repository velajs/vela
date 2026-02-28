import { METADATA_KEYS } from '../constants';
import { defineMetadata } from '../metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Type } from '../container/types';
import type { DynamicModule } from '../module/types';
import { Module } from '../module/decorators';
import { HttpService, HTTP_MODULE_OPTIONS } from './fetch.service';
import type { HttpModuleOptions } from './fetch.types';

@Module({
  providers: [
    { token: HTTP_MODULE_OPTIONS, useValue: {} },
    HttpService,
  ],
  exports: [HttpService],
})
export class HttpModule {
  /**
   * Configure HttpModule with options (baseURL, default headers, timeout).
   *
   * @example
   * ```ts
   * @Module({ imports: [HttpModule.register({ baseURL: 'https://api.example.com' })] })
   * class AppModule {}
   * ```
   */
  static register(options: HttpModuleOptions = {}): DynamicModule {
    const moduleClass = class HttpDynamicModule {} as unknown as Type;
    Object.defineProperty(moduleClass, 'name', { value: 'HttpModule' });

    defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
    MetadataRegistry.setModuleOptions(moduleClass, {
      exports: [HttpService, HTTP_MODULE_OPTIONS],
    });

    return {
      module: moduleClass,
      providers: [
        { token: HTTP_MODULE_OPTIONS, useValue: options },
        HttpService,
      ],
    };
  }
}
