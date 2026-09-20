import type { JWTPayload, JWTVerifyGetKey } from 'jose';

/**
 * The set of claims that ride inside a verified Zero Trust / OIDC token.
 *
 * This builds on `jose`'s {@link JWTPayload} (which already covers the registered
 * claims like `iss`/`aud`/`sub`/`exp`/`iat`) and layers on the extras a
 * Cloudflare Access token typically carries. What is actually populated varies by
 * caller: a person signing in through SSO shows up with `email` and a stable
 * `sub` (plus `groups` if the policy publishes them), whereas a machine using a
 * service token has a `common_name` and no meaningful `sub`. Because
 * {@link JWTPayload} keeps an index signature, any additional issuer-specific
 * claim simply comes along untouched.
 */
export interface AccessClaims extends JWTPayload {
  /** The signed-in user's verified email; populated on interactive SSO calls. */
  email?: string;
  /** The service-token label that stands in for `email` on machine-to-machine calls. */
  common_name?: string;
  /** Group memberships from the identity provider, if the policy is set to include them. */
  groups?: string[];
  /** Two-letter (ISO-3166-1 alpha-2) country of the authorizing request, where known. */
  country?: string;
  /** The token's kind marker, e.g. `"app"`. */
  type?: string;
}

/**
 * Everything needed to read a token off the wire and to know what to pin the
 * verification against. It lifts the four Cloudflare-specific constants (the
 * assertion header, the certs path, the team-domain issuer, and the auth cookie)
 * into parameters, which is what lets this same type back a plain OIDC/JWKS
 * issuer just as well. Construct one with
 * {@link import('./issuer').cloudflareAccessIssuer} or
 * {@link import('./issuer').genericOidcIssuer}.
 */
export interface IssuerPreset {
  /** Canonical `iss` a token must present — doubles as the JWKS origin. */
  issuer: string;
  /** Fully-qualified URL of the JWKS document. */
  jwksUri: string;
  /** The algorithm allow-list applied at verification (RS256-only unless widened). */
  algorithms: readonly string[];
  /** Header the token travels in (looked up case-insensitively). */
  header: string;
  /** Fallback cookie name used when the header is missing; leave unset to skip the cookie path. */
  cookie?: string;
  /** Set to strip a leading `Bearer ` from the header value before treating it as the token. */
  bearer?: boolean;
}

/**
 * Where the verifier gets its key from. It accepts a `jose` JWKS getter (remote
 * or local), a lone public key, or raw key material — chiefly so a test can feed
 * in a self-minted key without any network access. Leaving it out selects the
 * per-issuer remote JWKS from the shared cache.
 */
export type AccessKeySet = CryptoKey | Uint8Array | JWTVerifyGetKey;

/** Inputs to {@link import('./verify').verifyAccessJwt}. */
export interface VerifyAccessJwtOptions {
  /** Which issuer/wire preset to verify against. */
  preset: IssuerPreset;
  /**
   * The audience tag(s) this application answers to; the token's `aud` must
   * overlap. It is **mandatory** and enforced closed — a blank or missing value
   * is refused rather than read as "skip the audience check", so a token issued
   * for a neighbouring app on the same issuer cannot be accepted here.
   */
  aud: string | string[];
  /** Permitted clock drift, in **seconds**, when checking `exp`/`nbf`. Defaults to `0`. */
  clockToleranceSec?: number;
  /** Swap in an explicit key source. Chiefly a testing hook. */
  keySet?: AccessKeySet;
}

/** Inputs to the request-level primitives, adding a way to watch verification failures. */
export interface RequestVerifyOptions extends VerifyAccessJwtOptions {
  /**
   * Fires when a token was supplied but did not verify (signature, audience,
   * expiry, …). It is purely observational — the request still fails closed — and
   * it does **not** fire when there was no token at all. Anything it throws is
   * caught so the safe fallback cannot be disturbed.
   */
  onError?: (error: unknown, request: Request) => void;
}

/** Explicit mapping from external IdP groups to application-local roles. */
export type GroupRoleMapping = Readonly<Record<string, string | readonly string[]>>;

/** Stable principal kinds shared with `@velajs/authz`. */
export type PrincipalType = 'user' | 'service';

/**
 * The structural shape a resolved identity returns. `userId` is the durable
 * caller key; all other properties tag along as-is. Security-sensitive fields
 * are derived only from the verified JWT and cannot be replaced by `mapClaims`.
 */
export interface ResolvedIdentity {
  /** Any additional claims carried forward. */
  [claim: string]: unknown;
  /** Verified issuer namespace. */
  issuer: string;
  /** Stable issuer-local principal subject. */
  subject: string;
  /** Interactive user or machine/service principal. */
  principalType: PrincipalType;
  /** @deprecated Compatibility alias for `subject`. */
  userId: string;
  /** Verified absolute credential expiry in epoch milliseconds. */
  expiresAtMs: number;
  /** Tenant membership from the verified JWT tenantId claim. */
  tenantId?: string;
  /** Verified email for an SSO caller. */
  email?: string;
  /** Service-token label (`common_name`) for a machine caller. */
  commonName?: string;
  /** Group memberships from the issuer, when present. */
  groups?: string[];
  /** Application-local roles produced only by an explicit group mapping. */
  roles?: string[];
  /** The complete verified claim set, keeping the on-the-wire names. */
  claims: AccessClaims;
}

/**
 * A verifier in `resolveIdentity` shape: takes an incoming request and yields
 * either a verified {@link ResolvedIdentity} or `null` for anonymous. Being a
 * bare structural function type, it drops into a framework's identity hook with
 * no import of that framework.
 */
export type ResolveIdentity = (
  request: Request,
  env?: unknown,
) => Promise<ResolvedIdentity | null> | ResolvedIdentity | null;
