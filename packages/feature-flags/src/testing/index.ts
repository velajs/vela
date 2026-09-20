// @velajs/feature-flags/testing — the memory driver IS the fake. This subpath
// re-exports it plus a zero-DI helper for unit tests that want a real
// FeatureFlagsService over an in-memory driver without bootstrapping a module.

import { FeatureFlagDriverRegistry } from '../drivers/registry';
import { MemoryFlagDriver } from '../drivers/memory.driver';
import { FeatureFlagsService } from '../feature-flags.service';
import type { FeatureFlagsOptions, FlagManifest } from '../feature-flags.types';

export { MemoryFlagDriver, memoryFlagDriver } from '../drivers/memory.driver';
export type { MemoryFlagDriverOptions } from '../drivers/memory.driver';

export interface TestFeatureFlags {
  /** A real service bound to the memory driver below. */
  service: FeatureFlagsService;
  /** The backing memory driver — mutate flags with `.set()`/`.reset()`. */
  driver: MemoryFlagDriver;
}

/**
 * Build a real {@link FeatureFlagsService} over an in-memory driver, no DI /
 * app bootstrap required. Flip flags on the returned `driver` and assert on the
 * `service`.
 *
 * @example
 * ```ts
 * const { service, driver } = createTestFeatureFlags({ 'new-checkout': true });
 * expect(await service.getBooleanValue('new-checkout')).toBe(true);
 * driver.set('new-checkout', false);
 * expect(await service.getBooleanValue('new-checkout')).toBe(false);
 * ```
 */
export function createTestFeatureFlags(
  values: FlagManifest = {},
  options: Pick<FeatureFlagsOptions, 'manifest' | 'context'> = {},
): TestFeatureFlags {
  const driver = new MemoryFlagDriver({ values });
  const registry = new FeatureFlagDriverRegistry([driver], driver.name);
  const service = new FeatureFlagsService(registry, {
    default: driver.name,
    manifest: options.manifest,
    context: options.context,
  });
  return { service, driver };
}
