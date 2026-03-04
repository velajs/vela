import type { AsyncModuleOptions, DynamicModule } from '../module/types';
import { createModuleRef } from '../module/decorators';
import { Module } from '../module/decorators';
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
  static register(options: HttpModuleOptions = {}): DynamicModule {
    return {
      module: createModuleRef('HttpModule'),
      providers: [
        { provide: HTTP_MODULE_OPTIONS, useValue: options },
        HttpService,
      ],
      exports: [HttpService, HTTP_MODULE_OPTIONS],
    };
  }

  static registerAsync(options: AsyncModuleOptions<HttpModuleOptions>): DynamicModule {
    return {
      module: createModuleRef('HttpModule'),
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
