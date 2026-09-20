import { SetMetadata } from '@velajs/vela';
import type { FlagKey } from '../feature-flags.types';

/** What the {@link FeatureFlagGuard} does when a gated flag is off. */
export type FeatureFlagDisabledBehavior = 'notFound' | 'forbidden';

export interface FeatureFlagOptions {
  /**
   * Response when the flag is off. `'notFound'` (default) hides the route
   * entirely (404); `'forbidden'` reveals it exists but denies access (403).
   */
  onDisabled?: FeatureFlagDisabledBehavior;
}

/** The metadata `@FeatureFlag()` attaches, read by {@link FeatureFlagGuard}. */
export interface FeatureFlagMetadata {
  key: string;
  onDisabled: FeatureFlagDisabledBehavior;
}

export const FEATURE_FLAG_METADATA = 'vela:feature-flags:flag';

/**
 * Gate a route (handler) or controller behind a boolean feature flag. Pair
 * with {@link FeatureFlagGuard} (via `@UseGuards` or the module's `isGlobal`
 * app-wide registration).
 *
 * @example
 * ```ts
 * @UseGuards(FeatureFlagGuard)
 * @Controller('/checkout')
 * class CheckoutController {
 *   @FeatureFlag('new-checkout')            // 404 when off
 *   @Get('/v2') v2() { ... }
 *
 *   @FeatureFlag('beta', { onDisabled: 'forbidden' })  // 403 when off
 *   @Get('/beta') beta() { ... }
 * }
 * ```
 */
export function FeatureFlag(key: FlagKey, options: FeatureFlagOptions = {}) {
  const meta: FeatureFlagMetadata = { key, onDisabled: options.onDisabled ?? 'notFound' };
  return SetMetadata(FEATURE_FLAG_METADATA, meta);
}
