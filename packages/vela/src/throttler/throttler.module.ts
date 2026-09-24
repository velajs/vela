import { readEnv } from '../binding';
import { Container } from '../container/container';
import { Module } from '../module/decorators';
import { defineProvider } from '../container/types';
import { defineModule } from '../module/define-module';
import { APP_GUARD } from '../pipeline/tokens';
import { ThrottlerGuard } from './throttler.guard';
import { ThrottlerStorage } from './throttler.storage';
import { THROTTLER_OPTIONS, THROTTLER_STORAGE } from './throttler.tokens';
import type { ThrottlerModuleOptions } from './throttler.types';

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<ThrottlerModuleOptions>({
  name: 'Throttler',
  optionsToken: THROTTLER_OPTIONS,
});

@Module({
  providers: [
    // A storage function builds this application's store from its own ENV.
    defineProvider(THROTTLER_STORAGE, {
      useFactory: (options, container) =>
        typeof options.storage === 'function'
          ? options.storage(readEnv(container))
          : (options.storage ?? new ThrottlerStorage()),
      inject: [MODULE_OPTIONS_TOKEN, Container],
    }),
    ThrottlerGuard,
    defineProvider(APP_GUARD, { useExisting: ThrottlerGuard }),
  ],
  exports: [THROTTLER_OPTIONS, THROTTLER_STORAGE, ThrottlerGuard],
})
/**
 * Nest v5 named throttlers: `forRoot({ throttlers: [{ name, ttl, limit }, ...], storage? })`
 * registers the global `ThrottlerGuard`, which counts every request once per
 * throttler, each in its own bucket, and answers 429 at the first one
 * exceeded. `@Throttle({ name: { ttl, limit } })` and
 * `@SkipThrottle({ name: true })` adjust them per route or controller.
 */
export class ThrottlerModule extends ConfigurableModuleClass {}
