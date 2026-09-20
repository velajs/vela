import { moduleToken } from '@velajs/vela';
import type { FeatureFlagDriverRegistry } from './drivers/registry';
import type { FeatureFlagsService } from './feature-flags.service';
import type { FeatureFlagsOptions } from './feature-flags.types';

/**
 * Injection tokens for the feature-flags module. Named on the
 * `vela:feature-flags:<thing>` convention so identity is stable across
 * refactors and consumers can `@Inject(FEATURE_FLAG_TOKENS.Service)`.
 */
export const FEATURE_FLAG_TOKENS = {
  /** The resolved {@link FeatureFlagsOptions} (module options token). */
  Options: moduleToken<FeatureFlagsOptions>('vela:feature-flags:options'),
  /** The injectable {@link FeatureFlagsService}. */
  Service: moduleToken<FeatureFlagsService>('vela:feature-flags:service'),
  /** The {@link FeatureFlagDriverRegistry} built from the options' drivers. */
  DriverRegistry: moduleToken<FeatureFlagDriverRegistry>('vela:feature-flags:driver-registry'),
} as const;
