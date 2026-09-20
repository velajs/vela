import { Module } from '../module/decorators';
import { defineProvider } from '../container/types';
import { ConfigurableModuleBuilder } from '../module/configurable-module.builder';
import { APP_GUARD } from '../pipeline/tokens';
import { ThrottlerGuard } from './throttler.guard';
import { ThrottlerStorage } from './throttler.storage';
import { THROTTLER_OPTIONS, THROTTLER_STORAGE } from './throttler.tokens';
import type { ThrottlerModuleOptions } from './throttler.types';

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<ThrottlerModuleOptions>({
    moduleName: 'Throttler',
    optionsInjectionToken: THROTTLER_OPTIONS,
  }).build();

@Module({
  providers: [
    defineProvider(THROTTLER_STORAGE, {
      useFactory: (options) => options.storage ?? new ThrottlerStorage(),
      inject: [MODULE_OPTIONS_TOKEN],
    }),
    ThrottlerGuard,
    defineProvider(APP_GUARD, { useExisting: ThrottlerGuard }),
  ],
  exports: [THROTTLER_OPTIONS, THROTTLER_STORAGE, ThrottlerGuard],
})
export class ThrottlerModule extends ConfigurableModuleClass {}
