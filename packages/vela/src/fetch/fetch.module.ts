import { defineProvider } from '../container/types';
import { Module } from '../module/decorators';
import { defineModule } from '../module/define-module';
import { HttpService, HTTP_MODULE_OPTIONS } from './fetch.service';
import type { HttpModuleOptions } from './fetch.types';

const { ConfigurableModuleClass } = defineModule<
  HttpModuleOptions,
  never,
  { isGlobal?: boolean },
  'register'
>({
  name: 'Http',
  methodName: 'register',
  identity: 'registration',
  optionsToken: HTTP_MODULE_OPTIONS,
});

@Module({
  providers: [
    // Default for bare `imports: [HttpModule]`; register(options) overrides via merge.
    defineProvider(HTTP_MODULE_OPTIONS, { useValue: {} }),
    HttpService,
  ],
  exports: [HttpService, HTTP_MODULE_OPTIONS],
})
export class HttpModule extends ConfigurableModuleClass {}
