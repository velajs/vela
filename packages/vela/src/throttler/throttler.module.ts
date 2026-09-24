import { readEnv } from '../binding';
import { Container } from '../container/container';
import { Inject, Injectable } from '../container/decorators';
import { Module } from '../module/decorators';
import { defineProvider } from '../container/types';
import { DiscoveryService } from '../discovery/discovery.service';
import { defineModule } from '../module/define-module';
import { APP_GUARD } from '../pipeline/tokens';
import {
  ThrottlerGuard,
  checkThrottleRecord,
  declareThrottlers,
  type ThrottleRecord,
} from './throttler.guard';
import { ThrottlerStorage } from './throttler.storage';
import { THROTTLER_OPTIONS, THROTTLER_STORAGE, THROTTLE_METADATA } from './throttler.tokens';
import type { ThrottlerModuleOptions, ThrottlerStore } from './throttler.types';

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<ThrottlerModuleOptions>({
  name: 'Throttler',
  optionsToken: THROTTLER_OPTIONS,
});

/**
 * Checks every `@Throttle()` once, at bootstrap: a name the module does not
 * declare, or a changed value a fixed-limit store cannot enforce, fails the
 * application instead of every request to the route.
 */
@Injectable()
class ThrottlerConfiguration {
  constructor(
    @Inject(THROTTLER_OPTIONS) private readonly options: ThrottlerModuleOptions,
    @Inject(THROTTLER_STORAGE) private readonly storage: ThrottlerStore,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
  ) {}

  onApplicationBootstrap(): void {
    const throttlers = declareThrottlers(this.options.throttlers);
    const { fixedLimits } = this.storage;
    const filter = { metadataOnly: true, deferLazy: true };
    for (const { metatype, meta } of this.discovery.providersWithMeta<ThrottleRecord>(
      THROTTLE_METADATA,
      filter,
    )) {
      checkThrottleRecord(meta, metatype.name, throttlers, fixedLimits);
    }
    for (const { class: owner, methodName, meta } of this.discovery.methodsWithMeta<ThrottleRecord>(
      THROTTLE_METADATA,
      filter,
    )) {
      checkThrottleRecord(
        meta,
        `${owner.metatype.name}.${String(methodName)}`,
        throttlers,
        fixedLimits,
      );
    }
  }
}

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
    ThrottlerConfiguration,
    defineProvider(APP_GUARD, { useExisting: ThrottlerGuard }),
  ],
  exports: [THROTTLER_OPTIONS, THROTTLER_STORAGE, ThrottlerGuard],
})
/**
 * Nest v5 named throttlers: `forRoot({ throttlers: [{ name, ttl, limit }, ...], storage? })`
 * registers the global `ThrottlerGuard`, which counts every request once per
 * throttler, each in its own bucket, and answers 429 at the first one
 * exceeded. `@Throttle({ name: { ttl, limit } })` and
 * `@SkipThrottle({ name: true })` adjust them per route or controller; a
 * `@Throttle()` naming an undeclared throttler fails at bootstrap.
 */
export class ThrottlerModule extends ConfigurableModuleClass {}
