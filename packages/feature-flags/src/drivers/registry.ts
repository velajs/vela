import { FeatureFlagError } from '../feature-flags.error';
import type { FeatureFlagsOptions } from '../feature-flags.types';
import type { FeatureFlagDriver } from './driver';
import { MemoryFlagDriver } from './memory.driver';

/**
 * The set of registered {@link FeatureFlagDriver}s plus the default selection.
 * Built once per module instance ({@link buildDriverRegistry}) and injected
 * into {@link FeatureFlagsService}; `use(name)` looks a driver up here.
 */
export class FeatureFlagDriverRegistry {
  private readonly drivers = new Map<string, FeatureFlagDriver>();
  readonly defaultName: string;

  constructor(drivers: readonly FeatureFlagDriver[], defaultName?: string) {
    if (drivers.length === 0) {
      throw new FeatureFlagError(
        'No feature flag drivers registered. Provide at least one driver to FeatureFlagsModule.forRoot({ drivers: [...] }).',
      );
    }
    for (const driver of drivers) {
      if (this.drivers.has(driver.name)) {
        throw new FeatureFlagError(`Duplicate feature flag driver "${driver.name}".`);
      }
      this.drivers.set(driver.name, driver);
    }
    const requested = defaultName ?? drivers[0]!.name;
    if (!this.drivers.has(requested)) {
      throw new FeatureFlagError(`Default feature flag driver "${requested}" is not registered.`);
    }
    this.defaultName = requested;
  }

  /** Look a driver up by name; throws {@link FeatureFlagError} when unknown. */
  get(name: string): FeatureFlagDriver {
    const driver = this.drivers.get(name);
    if (!driver) {
      throw new FeatureFlagError(`Feature flag driver "${name}" is not registered.`);
    }
    return driver;
  }

  /** Resolve a named driver, or the default when `name` is omitted. */
  resolve(name?: string): FeatureFlagDriver {
    return this.get(name ?? this.defaultName);
  }

  /** All registered driver names. */
  names(): string[] {
    return [...this.drivers.keys()];
  }
}

/**
 * Build the driver registry from module options. Falls back to a single
 * in-memory driver when none are configured, so `FeatureFlagsModule.forRoot({})`
 * yields a working (all-defaults) flags service for local development.
 */
export function buildDriverRegistry(options: FeatureFlagsOptions): FeatureFlagDriverRegistry {
  const drivers =
    options.drivers && options.drivers.length > 0 ? options.drivers : [new MemoryFlagDriver()];
  return new FeatureFlagDriverRegistry(drivers, options.default);
}
