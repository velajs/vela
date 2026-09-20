import { jwtVerify, type JWTPayload } from 'jose';
import { getRemoteJwks } from './jwks-cache';
import { readToken } from './read-token';
import type { AccessClaims, RequestVerifyOptions, VerifyAccessJwtOptions } from './types';

/**
 * Collapse the configured audience into a de-noised `string[]`: array or scalar
 * in, blanks and non-strings dropped. An empty result is an error, not an empty
 * array.
 *
 * Why be strict: many apps live behind one issuer, and the JWKS is shared among
 * them, so `aud` is the field that says "this token was minted for *this* app".
 * `jose` treats a falsy `audience` option as "don't check audience at all", which
 * means a blank config value (an `AUD` that never got set) would quietly turn the
 * check off and let a sibling app's token in. Rejecting the blank keeps the door
 * shut by default.
 */
export const normalizeAudiences = (aud: VerifyAccessJwtOptions['aud']): string[] => {
  const candidates = Array.isArray(aud) ? aud : [aud];
  const list = candidates.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
  if (list.length === 0) {
    throw new Error(
      '@velajs/cloudflare-access: an audience is mandatory — a token cannot be verified without at ' +
        'least one non-empty aud tag to bind it to this application',
    );
  }
  return list;
};

/**
 * Run the cheap, request-independent config checks once, up front, so a broken
 * deployment surfaces at boot rather than turning every caller into an anonymous
 * one with no trace of why. Three things must hold: the preset carries an issuer,
 * its JWKS URI is a parseable URL, and at least one audience survives
 * normalization.
 */
export const assertVerifyOptions = (options: VerifyAccessJwtOptions): void => {
  if (options.preset.issuer.length === 0) {
    throw new Error('@velajs/cloudflare-access: preset.issuer must be a non-empty issuer');
  }
  // `new URL` throws when the JWKS location is malformed — that is the check.
  new URL(options.preset.jwksUri);
  normalizeAudiences(options.aud);
};

/**
 * Validate a compact JWT and hand back its payload.
 *
 * A single `jose` call does four jobs at once: it checks the signature against
 * the issuer's key set while restricting the accepted algorithms to
 * `preset.algorithms` (which defaults to RS256 alone, so a token that claims
 * `none` or a symmetric algorithm never gets a chance to verify); it requires the
 * `iss` claim to equal `preset.issuer`; it requires `aud` to overlap the
 * configured audiences; and it rejects an already-expired token, honoring the
 * optional skew allowance. Failure is signalled by a thrown `jose` error; a
 * caller wanting anonymous-on-failure catches it and moves on.
 */
export const verifyAccessJwt = async (
  token: string,
  options: VerifyAccessJwtOptions,
): Promise<AccessClaims> => {
  const audience = normalizeAudiences(options.aud);
  const keySet = options.keySet ?? getRemoteJwks(options.preset.jwksUri);

  const verifyOptions = {
    algorithms: [...options.preset.algorithms],
    audience,
    issuer: options.preset.issuer,
    ...(options.clockToleranceSec === undefined
      ? {}
      : { clockTolerance: options.clockToleranceSec }),
  };

  // jose exposes separate key and key-resolver overloads; narrow before calling.
  const { payload } =
    typeof keySet === 'function'
      ? await jwtVerify(token, keySet, verifyOptions)
      : await jwtVerify(token, keySet, verifyOptions);
  if (!validAccessClaims(payload)) {
    throw new Error('@velajs/cloudflare-access: invalid Access claim shape');
  }
  const expiresAtMs = typeof payload.exp === 'number' ? payload.exp * 1000 : Number.NaN;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
    throw new Error('@velajs/cloudflare-access: a finite exp claim is required');
  }
  return payload;
};

/**
 * Locate a token on the request and verify it, folding both "nothing to verify"
 * and "verification failed" into a single `undefined` return — the one value the
 * higher-level resolver reads as "treat this caller as anonymous". The `onError`
 * hook is invoked only in the second case (a token was there but did not check
 * out); an absent token is silent. Whatever the hook does, its own exceptions are
 * caught here so an observability callback can never flip the safe default.
 */
export const verifyRequest = async (
  request: Request,
  options: RequestVerifyOptions,
): Promise<AccessClaims | undefined> => {
  const token = readToken(request, options.preset);
  if (token === undefined) return undefined;

  try {
    return await verifyAccessJwt(token, options);
  } catch (error) {
    try {
      options.onError?.(error, request);
    } catch {
      /* an observer that throws must not undo the anonymous fallback below */
    }
    return undefined;
  }
};

/** Validate the complete declared shape, including optional fields jose need not inspect. */
function validAccessClaims(payload: JWTPayload): payload is AccessClaims {
  for (const key of ['iss', 'sub', 'jti', 'email', 'common_name', 'country', 'type']) {
    if (payload[key] !== undefined && typeof payload[key] !== 'string') return false;
  }
  for (const key of ['exp', 'nbf', 'iat']) {
    const value = payload[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  }
  if (
    payload.aud !== undefined &&
    typeof payload.aud !== 'string' &&
    !(
      Array.isArray(payload.aud) && payload.aud.every((entry: unknown) => typeof entry === 'string')
    )
  )
    return false;
  return (
    payload.groups === undefined ||
    (Array.isArray(payload.groups) &&
      payload.groups.every((group: unknown) => typeof group === 'string'))
  );
}
