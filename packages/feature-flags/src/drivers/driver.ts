import type { FlagContext, FlagEvaluationDetails } from '../feature-flags.types';

/**
 * The cross-package contract every feature-flag backend implements.
 *
 * This is the seam that platform packages plug into: `@velajs/cloudflare`
 * ships a Flagship-binding driver and a KV-backed driver against this exact
 * interface, `@velajs/feature-flags` ships {@link MemoryFlagDriver}. A driver
 * maps a key + fallback (+ optional targeting context) onto a value and
 * returns the `fallback` when it cannot resolve the key. Unexpected failures
 * may reject; the service owns the never-throw boundary.
 *
 * Optional detail methods preserve provider metadata. Without one, the service
 * reports UNKNOWN: a returned fallback cannot be distinguished from a hit.
 */
export interface FeatureFlagDriver {
  readonly name: string;
  getBoolean(key: string, fallback: boolean, ctx?: FlagContext): Promise<boolean>;
  getString(key: string, fallback: string, ctx?: FlagContext): Promise<string>;
  getNumber(key: string, fallback: number, ctx?: FlagContext): Promise<number>;
  /** Object payloads remain unknown until the service applies the caller's parser. */
  getObject(key: string, fallback: object, ctx?: FlagContext): Promise<unknown>;
  getBooleanDetails?(
    key: string,
    fallback: boolean,
    ctx?: FlagContext,
  ): Promise<FlagEvaluationDetails<boolean>>;
  getStringDetails?(
    key: string,
    fallback: string,
    ctx?: FlagContext,
  ): Promise<FlagEvaluationDetails<string>>;
  getNumberDetails?(
    key: string,
    fallback: number,
    ctx?: FlagContext,
  ): Promise<FlagEvaluationDetails<number>>;
  getObjectDetails?(
    key: string,
    fallback: object,
    ctx?: FlagContext,
  ): Promise<FlagEvaluationDetails<unknown>>;
}
