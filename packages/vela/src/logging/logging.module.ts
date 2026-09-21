import { InjectionToken, defineProvider } from '../container/types';
import { defineModule } from '../module/define-module';
import { ApplicationLogger } from './application-logger';
import type { ApplicationLoggerOptions } from './log.types';

export const APP_LOGGER = new InjectionToken<ApplicationLogger>('vela.applicationLogger');

const { ConfigurableModuleClass } = defineModule<ApplicationLoggerOptions>({
  name: 'Logging',
  extras: { isGlobal: true },
  key: () => 'application',
  setup: ({ OPTIONS }) => ({
    providers: [
      defineProvider(APP_LOGGER, {
        inject: [OPTIONS],
        useFactory: (options) => new ApplicationLogger(options),
      }),
    ],
    exports: [APP_LOGGER],
  }),
});

/** Import once per application. Optional; legacy Logger/Writer calls keep their existing behavior. */
export class LoggingModule extends ConfigurableModuleClass {}
