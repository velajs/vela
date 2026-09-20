import type { FlagContext } from '../feature-flags.types';

/**
 * The cross-package contract every feature-flag backend implements.
 *
 * This is the seam that platform packages plug into: `@velajs/cloudflare`
 * ships a Flagship-binding driver and a KV-backed driver against this exact
 * interface, `@velajs/feature-flags` ships {@link MemoryFlagDriver}. A driver
 * maps a key + fallback (+ optional targeting context) onto a value and
 * MUST return the `fallback` — never throw — when it cannot resolve the key.
 *
 * Evaluation *details* (`FlagEvaluationDetails`) are synthesized by
 * `FeatureFlagsService` around these four value methods; drivers may
 * optionally override that synthesis, but the value methods are the contract.
 */
export interface FeatureFlagDriver {
  readonly name: string;
  getBoolean(key: string, fallback: boolean, ctx?: FlagContext): Promise<boolean>;
  getString(key: string, fallback: string, ctx?: FlagContext): Promise<string>;
  getNumber(key: string, fallback: number, ctx?: FlagContext): Promise<number>;
  /** Object payloads remain unknown until the service applies the caller's parser. */
  getObject(key: string, fallback: object, ctx?: FlagContext): Promise<unknown>;
  // details are synthesized by the service; drivers may optionally override
}
