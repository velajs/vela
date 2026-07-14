import type { IdentityContract } from './identity-contract';
import type {
  AccessClaims,
  AccessKeySet,
  IssuerPreset,
  RequestVerifyOptions,
  ResolvedIdentity,
  ResolveIdentity,
} from './types';
import { assertVerifyOptions, verifyRequest } from './verify';

/**
 * Raised by a resolver when a claim set is rejected by a contract configured with
 * `onInvalid: "reject"`. The `401` status lets a framework guard translate it
 * into an Unauthorized response. The message is deliberately value-free.
 */
export class IdentityRejectedError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = 'IdentityRejectedError';
  }
}

/** Options for {@link createAccessResolver}. */
export interface CreateAccessResolverOptions {
  /** The wire/issuer preset. */
  preset: IssuerPreset;
  /** Required application audience tag(s). Fail-closed when empty. */
  aud: string | string[];
  /** Rewrite verified claims into extra identity fields; a returned `userId` overrides the derived one. */
  mapClaims?: (claims: AccessClaims) => Record<string, unknown>;
  /** Optional claim contract run over the verified claims before an identity is assembled. */
  identity?: IdentityContract;
  /** Observe present-but-invalid tokens. Never called for an absent token. */
  onError?: (error: unknown, request: Request) => void;
  /** Clock-skew tolerance in seconds. */
  clockToleranceSec?: number;
  /** Override the verification key source. Primarily for tests. */
  keySet?: AccessKeySet;
}

/** Coerce a value to a non-empty string, mapping `""`, non-strings, and nullish to `undefined`. */
const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * Pick the caller's durable id out of the verified claims. Interactive logins put
 * it in `sub`; when that is blank (service tokens have no `sub`) the code walks on
 * to `email` and finally `common_name`. If all three are empty there is no usable
 * id, so the caller is left anonymous rather than being assigned an empty-string
 * id that every id-less caller would end up sharing.
 */
const deriveUserId = (claims: AccessClaims): string | undefined =>
  nonEmptyString(claims.sub) ?? nonEmptyString(claims.email) ?? nonEmptyString(claims.common_name);

/**
 * Assemble the {@link ResolvedIdentity}. The whole claim set is retained under
 * `claims`; the frequently-read fields (`email`, `commonName`, `groups`, `exp`)
 * are lifted to top-level keys when present, `exp` in epoch seconds so a socket
 * layer can time out an expiring credential. `mapClaims` output is applied last,
 * with `userId` skipped here because the id was already settled by the caller.
 */
const buildResolvedIdentity = (
  claims: AccessClaims,
  userId: string,
  overrides: Record<string, unknown>,
): ResolvedIdentity => {
  const resolved: ResolvedIdentity = { userId, claims };
  if (claims.email !== undefined) resolved.email = claims.email;
  if (claims.common_name !== undefined) resolved.commonName = claims.common_name;
  if (claims.groups !== undefined) resolved.groups = claims.groups;
  if (typeof claims.exp === 'number') resolved.exp = claims.exp;

  for (const [key, value] of Object.entries(overrides)) {
    if (key !== 'userId') resolved[key] = value;
  }
  return resolved;
};

/**
 * Convert verified claims into a {@link ResolvedIdentity}, or `null` when no id is
 * available. `mapClaims` (if given) runs first, so a caller may inject fields and,
 * via a returned `userId`, take over the id; absent that override the id comes
 * from {@link deriveUserId}. A missing id short-circuits to anonymous instead of
 * producing an identity keyed on the empty string.
 */
const toResolvedIdentity = (
  claims: AccessClaims,
  mapClaims?: (claims: AccessClaims) => Record<string, unknown>,
): ResolvedIdentity | null => {
  const overrides = mapClaims ? mapClaims(claims) : {};
  const userId = nonEmptyString(overrides.userId) ?? deriveUserId(claims);
  if (userId === undefined) return null;
  return buildResolvedIdentity(claims, userId, overrides);
};

/**
 * Produce a `resolveIdentity` function that turns a request into a verified
 * identity or anonymous `null`. Per call it verifies the token, optionally runs
 * the claim set through a {@link IdentityContract}, and shapes the result.
 *
 * The safe default runs through every branch: no token, an unverifiable token, or
 * (under `onInvalid: "anonymous"`) a contract miss all yield `null`. A contract
 * configured to `reject` instead throws {@link IdentityRejectedError}. Static
 * configuration is checked eagerly via {@link assertVerifyOptions}, so a
 * misconfigured build is loud at startup rather than silently anonymous later.
 */
export const createAccessResolver = (options: CreateAccessResolverOptions): ResolveIdentity => {
  assertVerifyOptions(options);

  const verifyOptions: RequestVerifyOptions = {
    preset: options.preset,
    aud: options.aud,
    ...(options.clockToleranceSec === undefined
      ? {}
      : { clockToleranceSec: options.clockToleranceSec }),
    ...(options.keySet === undefined ? {} : { keySet: options.keySet }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  };

  return async (request: Request): Promise<ResolvedIdentity | null> => {
    const claims = await verifyRequest(request, verifyOptions);
    if (claims === undefined) return null;

    if (options.identity !== undefined) {
      const result = await options.identity.validate(claims);
      if (!result.ok) {
        if (options.identity.onInvalid === 'reject') {
          throw new IdentityRejectedError(
            `identity claims failed the declared contract: ${result.error}`,
          );
        }
        return null;
      }
    }

    return toResolvedIdentity(claims, options.mapClaims);
  };
};

/**
 * Chain resolvers into a single one that consults them left to right and returns
 * the first identity that comes back non-null; if every one declines, the result
 * is anonymous `null`. Resolution is strictly sequential on purpose — each step
 * gets a chance to claim the request before the next is asked.
 */
export const composeResolvers =
  (...resolvers: ResolveIdentity[]): ResolveIdentity =>
  async (request: Request, env?: unknown): Promise<ResolvedIdentity | null> => {
    for (const resolve of resolvers) {
      const identity = await resolve(request, env);
      if (identity) return identity;
    }
    return null;
  };
