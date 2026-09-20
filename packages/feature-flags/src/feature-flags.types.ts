import type { RequestContext } from '@velajs/vela';
import type { FeatureFlagDriver } from './drivers/driver';

/**
 * A value a feature flag can resolve to. Mirrors the four evaluation methods
 * on {@link FeatureFlagDriver}.
 */
export type FlagValue = boolean | string | number | object;

/**
 * A free-form evaluation context handed to a driver (for targeting: user id,
 * plan, country, …). Drivers that don't do targeting ignore it.
 */
export type FlagContext = Record<string, unknown>;

/**
 * Augment this interface to get typed flag keys on the service and the
 * `@FeatureFlag()` decorator.
 *
 * @example
 * ```ts
 * declare module '@velajs/feature-flags' {
 *   interface FeatureFlagRegistry {
 *     'new-checkout': boolean;
 *     'checkout-flow': string;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FeatureFlagRegistry {}

/**
 * A flag key. Narrows to the declared {@link FeatureFlagRegistry} keys when the
 * app augments it; falls back to `string` otherwise.
 */
export type FlagKey = keyof FeatureFlagRegistry extends never
  ? string
  : keyof FeatureFlagRegistry & string;

/**
 * A declared set of flags and their default values.
 *
 * Drivers have no enumeration API, so the flags you intend to evaluate as a
 * batch (via {@link FeatureFlagsService.all}) must be declared once here. Each
 * default also doubles as the type hint used to pick the evaluation method.
 */
export type FlagManifest = Record<string, FlagValue>;

/** Why an evaluation returned the value it did. */
export type FlagEvaluationReason = 'STATIC' | 'DEFAULT' | 'ERROR';

/** A flag value plus the metadata the service synthesizes around a driver read. */
export interface FlagEvaluationDetails<T extends FlagValue = FlagValue> {
  flagKey: string;
  value: T;
  reason: FlagEvaluationReason;
  errorMessage?: string;
}

/**
 * Feature-flags module configuration.
 */
export interface FeatureFlagsOptions {
  /**
   * The drivers this app can evaluate against. When omitted, a single
   * in-memory {@link MemoryFlagDriver} named `"memory"` is used (all flags
   * resolve to their declared defaults).
   */
  drivers?: FeatureFlagDriver[];
  /** Name of the driver the injected service targets. Defaults to `drivers[0].name`. */
  default?: string;
  /** Declared flags + defaults. Powers manifest defaults and {@link FeatureFlagsService.all}. */
  manifest?: FlagManifest;
  /**
   * Resolves a per-request evaluation context (for example `{ userId }`) merged
   * into every evaluation. Per-call context may override targeting fields, but
   * trusted identity keys (`userId`, tenant/org/account ids, subject) from this
   * resolver always win.
   * Receives the current request context; skipped outside request scope.
   */
  context?: (ctx: RequestContext) => FlagContext | Promise<FlagContext>;
}
