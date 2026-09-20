import { APP_GUARD, Scope, defineModule, defineProvider } from '@velajs/vela';
import { buildDriverRegistry } from './drivers/registry';
import { FeatureFlagGuard } from './guards/feature-flag.guard';
import { FeatureFlagsService } from './feature-flags.service';
import { FEATURE_FLAG_TOKENS } from './feature-flags.tokens';
import type { FeatureFlagsOptions } from './feature-flags.types';

/**
 * The feature-flags module. Authored on vela's public `defineModule`, so
 * `forRoot({ drivers, default?, manifest?, context?, isGlobal? })` and the
 * matching `forRootAsync({ inject, useFactory, ... })` come for free.
 *
 * `lazy: true` is valid here: every provider is sync-constructible (a factory
 * for the driver registry, a sync-constructor service, a guard) and there are
 * no async lifecycle hooks — so the module defers to first use without
 * violating the sync-seam rule (see vela `MODULE_AUTHORING.md`).
 *
 * `isGlobal: true` makes the module globally visible AND registers
 * {@link FeatureFlagGuard} app-wide (`APP_GUARD`) so every `@FeatureFlag()`
 * route is gated without a per-controller `@UseGuards`.
 */
const { ConfigurableModuleClass } = defineModule<FeatureFlagsOptions>({
  name: 'FeatureFlags',
  optionsToken: FEATURE_FLAG_TOKENS.Options,
  lazy: true,
  transform: (definition, extras) =>
    extras.isGlobal
      ? {
          ...definition,
          global: true,
          providers: [
            ...(definition.providers ?? []),
            defineProvider(APP_GUARD, { useExisting: FeatureFlagGuard }),
          ],
        }
      : definition,
  setup: ({ OPTIONS }) => ({
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
