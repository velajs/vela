import { InjectionToken } from '@velajs/vela';
import type { IdentityContract } from '../identity-contract';
import type { AccessClaims, AccessKeySet, IssuerPreset, ResolveIdentity } from '../types';

/**
 * RequestContext key under which {@link CloudflareAccessGuard} stashes the
 * verified {@link import('../types').ResolvedIdentity}. `Symbol.for` so any
 * package (a decorator, a downstream guard) can read it by the same global
 * symbol without importing this one — the identity handoff stays structural.
 */
export const ACCESS_IDENTITY_KEY: unique symbol = Symbol.for('vela.cloudflare-access.identity');

/**
 * RequestContext key carrying the credential expiry the guard resolved
 * (`expiresAtMs` when present, else `exp` in epoch seconds). This is the data a
 * WebSocket-upgrade route reads to drive DO socket expiry.
 */
export const ACCESS_EXP_KEY: unique symbol = Symbol.for('vela.cloudflare-access.exp');

/**
 * The `Symbol.for` key `@velajs/better-auth` writes its user under. The guard
 * projects an Access identity here only when `betterAuthInterop` is enabled, so
 * the unchanged better-auth `PermissionGuard` can consume an Access caller. Kept
 * as a raw `Symbol.for` — no `@velajs/better-auth` import.
 */
export const BETTER_AUTH_USER_KEY: unique symbol = Symbol.for('vela.better-auth.user');

/** How the guard treats an anonymous (unverified) caller. */
export type CloudflareAccessMode = 'required' | 'optional';

/** Options for {@link CloudflareAccessModule}. */
export interface CloudflareAccessModuleOptions {
  /** The wire/issuer preset (`cloudflareAccessIssuer(...)` or `genericOidcIssuer(...)`). */
  preset: IssuerPreset;
  /** Required application audience tag(s). Fail-closed when empty. */
  aud: string | string[];
  /** `required` (default) rejects anonymous callers; `optional` lets them pass through. */
  mode?: CloudflareAccessMode;
  /** Optional declared claim contract run over the verified claims before an identity is minted. */
  identity?: IdentityContract;
  /** Remap verified claims into extra identity fields. */
  mapClaims?: (claims: AccessClaims) => Record<string, unknown>;
  /** Clock-skew tolerance in seconds. */
  clockToleranceSec?: number;
  /** Override the verification key source. Primarily for tests. */
  keySet?: AccessKeySet;
  /** Observe present-but-invalid tokens. */
  onError?: (error: unknown, request: Request) => void;
  /**
   * When `true`, also project the Access identity under {@link BETTER_AUTH_USER_KEY}
   * as `{ id, role }` so the unchanged better-auth `PermissionGuard` consumes it.
   * Off by default (opt-in interop shim).
   */
  betterAuthInterop?: boolean;
}

/** The auto-provided options bag passed to {@link CloudflareAccessModule}. */
export const ACCESS_MODULE_OPTIONS = new InjectionToken<CloudflareAccessModuleOptions>(
  'vela.cloudflare-access.options',
);

/**
 * The built {@link ResolveIdentity} the module provides and exports. Exported so
 * an app can inject it and pass it to `composeResolvers(...)` alongside other
 * schemes.
 */
export const ACCESS_RESOLVER = new InjectionToken<ResolveIdentity>(
  'vela.cloudflare-access.resolver',
);
