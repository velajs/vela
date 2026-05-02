import type { AsyncModuleOptions, DynamicModule } from '../module/types';
import { Module } from '../module/decorators';
import { stableHash } from '../module/stable-hash';
import { HttpService, HTTP_MODULE_OPTIONS } from './fetch.service';
import type { HttpModuleOptions } from './fetch.types';

@Module({
  providers: [
    { provide: HTTP_MODULE_OPTIONS, useValue: {} },
    HttpService,
  ],
  exports: [HttpService],
})
export class HttpModule {
  static forRoot(options: HttpModuleOptions = {}): DynamicModule {
    return {
      module: HttpModule,
      key: stableHash(options),
      providers: [
        { provide: HTTP_MODULE_OPTIONS, useValue: options },
        HttpService,
      ],
      exports: [HttpService, HTTP_MODULE_OPTIONS],
    };
  }

  static forRootAsync(
    options: AsyncModuleOptions<HttpModuleOptions> & { key?: string },
  ): DynamicModule {
    return {
      module: HttpModule,
      key: options.key ?? stableHash({ inject: options.inject, useFactory: options.useFactory }),
      imports: options.imports ?? [],
      providers: [
        {
          provide: HTTP_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        HttpService,
      ],
      exports: [HttpService, HTTP_MODULE_OPTIONS],
    };
  }
}
