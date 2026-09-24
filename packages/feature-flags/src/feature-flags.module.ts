import { APP_GUARD, Scope, defineModule, defineProvider } from '@velajs/vela';
import { buildDriverRegistry } from './drivers/registry';
import { FeatureFlagGuard } from './guards/feature-flag.guard';
import { FeatureFlagsService } from './feature-flags.service';
import { FEATURE_FLAG_TOKENS } from './feature-flags.tokens';
import type { FeatureFlagsOptions } from './feature-flags.types';

/**
 * The feature-flags module. Authored on vela's public `defineModule`, so
 * `forRoot({ drivers, default?, manifest?, context?, globalGuard?, isGlobal? })`
 * and the matching `forRootAsync({ inject, useFactory, globalGuard? })` come
 * for free.
 *
 * `lazy: true` is valid here: every provider is sync-constructible (a factory
 * for the driver registry, a sync-constructor service, a guard) and there are
 * no async lifecycle hooks — so the module defers to first use without
 * violating the sync-seam rule (see `docs/modules.md`).
 *
 * {@link FeatureFlagGuard} is registered app-wide (`APP_GUARD`) by default,
 * so every `@FeatureFlag()` route is gated without a per-controller
 * `@UseGuards`; `globalGuard: false` leaves gating to `@UseGuards`.
 * `isGlobal: true` makes the service visible to every module.
 */
const { ConfigurableModuleClass } = defineModule<FeatureFlagsOptions, 'globalGuard'>({
  name: 'FeatureFlags',
  optionsToken: FEATURE_FLAG_TOKENS.Options,
  lazy: true,
  structural: ['globalGuard'],
  // `globalGuard: true` configures what leaving it out does: one instance, one guard.
  defaults: { globalGuard: true },
  setup: ({ OPTIONS, options }) => ({
    providers: [
      defineProvider(FEATURE_FLAG_TOKENS.DriverRegistry, {
        useFactory: (options) => buildDriverRegistry(options),
        inject: [OPTIONS],
      }),
      // Transient: a fresh service per injection, so `use()`/`forRequest()`
      // clones and per-request context stay isolated. The service never injects
      // REQUEST_CONTEXT, so it does not bubble to request scope and remains
      // resolvable in queue / scheduled / global scope.
      defineProvider(FEATURE_FLAG_TOKENS.Service, {
        useClass: FeatureFlagsService,
        scope: Scope.TRANSIENT,
      }),
      FeatureFlagGuard,
      // Fail closed: every @FeatureFlag() route is gated unless the app opts
      // out and gates per route with @UseGuards(FeatureFlagGuard).
      ...(options.globalGuard === false
        ? []
        : [defineProvider(APP_GUARD, { useExisting: FeatureFlagGuard })]),
    ],
    exports: [
      FEATURE_FLAG_TOKENS.Service,
      FEATURE_FLAG_TOKENS.DriverRegistry,
      FeatureFlagGuard,
      OPTIONS,
    ],
  }),
});

export class FeatureFlagsModule extends ConfigurableModuleClass {}
