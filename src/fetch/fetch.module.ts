import { Module } from '../module/decorators';
import { ConfigurableModuleBuilder } from '../module/configurable-module.builder';
import { HttpService, HTTP_MODULE_OPTIONS } from './fetch.service';
import type { HttpModuleOptions } from './fetch.types';

const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<HttpModuleOptions>({
  moduleName: 'Http',
  optionsInjectionToken: HTTP_MODULE_OPTIONS,
}).build();

@Module({
  providers: [
    // Default for bare `imports: [HttpModule]`; forRoot(options) overrides via merge.
    { provide: HTTP_MODULE_OPTIONS, useValue: {} },
    HttpService,
  ],
  exports: [HttpService, HTTP_MODULE_OPTIONS],
})
export class HttpModule extends ConfigurableModuleClass {}
