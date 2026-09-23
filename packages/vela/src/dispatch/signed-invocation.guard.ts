import { Inject, Injectable, Optional } from '../container/decorators';
import { declareRootDefault } from '../container/root-defaults';
import { sha256Base64Url } from '../crypto/hmac';
import { verifyInvocation } from '../crypto/invocation';
import { InjectEnv, type VelaEnv } from '../env';
import { ForbiddenException } from '../errors/http-exception';
import { applyDecorators } from '../http/decorators';
import { URL_SIGNING_SECRET, resolveSigningSecret } from '../http/url/signing-secret';
import { UseGuards, UseMiddleware } from '../pipeline/decorators';
import type { CanActivate, ExecutionContext } from '../pipeline/types';
import { SignedInvocationBodyCapture, takeCapturedBodyHash } from './signed-body-capture';
import { NONCE_STORE } from './nonce-store';
import { INVOCATION_HEADER, INVOCATION_SIGNING_SECRET } from './tokens';
import type { NonceStore } from './types';

// One opaque, generic 403 for EVERY failure mode — a missing/tampered/expired
// token, a method/path/body mismatch, or a replayed nonce all look identical to
// a caller, so nothing leaks which check tripped (and never the secret).
const INVALID = 'Invalid or expired invocation';

// A sentinel that can NEVER equal a real base64url SHA-256 digest (base64url has
// no NUL byte and the empty-body case is the empty string). Returned when the
// body was already consumed WITHOUT the capture middleware — the bare-guard
// misuse (`@UseGuards(SignedInvocationGuard)` sans `@SignedInvocation()`) on a
// `@Body()` handler — so `claim.bodyHash !== bodyHash` always holds → generic
// 403, never a 500. Fail-closed.
const UNRECOVERABLE_BODY = '\u0000';

/**
 * Hash the live request body, tolerating an already-consumed stream. Returns
 * `''` for an empty body, `base64url(SHA-256(bytes))` otherwise, or the
 * fail-closed sentinel when `clone()` throws (body already used). Only reached
 * when the capture middleware did not run.
 */
async function hashLiveBody(request: Request): Promise<string> {
  try {
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    return bytes.byteLength === 0 ? '' : await sha256Base64Url(bytes);
  } catch {
    return UNRECOVERABLE_BODY;
  }
}

/**
 * Verifies the signed invocation token on `x-vela-invocation` and binds it to
 * the live request: the claim's `method`, composed `path`, and `bodyHash` must
 * all match, and the single-use `nonce` must be unseen. Fail-closed — any
 * anomaly is a 403. The signature IS the authorization for the route, so put
 * internally-invoked handlers on dedicated `@SignedInvocation()` routes rather
 * than blanket-trusting a header.
 */
@Injectable()
export class SignedInvocationGuard implements CanActivate {
  readonly #invocationSecret: string | undefined;
  readonly #urlSecret: string | undefined;
  readonly #env: VelaEnv | undefined;

  constructor(
    @Optional() @Inject(INVOCATION_SIGNING_SECRET) invocationSecret?: string,
    @Optional() @Inject(URL_SIGNING_SECRET) urlSecret?: string,
    @Optional() @Inject(NONCE_STORE) private readonly nonceStore?: NonceStore,
    @Optional() @InjectEnv() env?: VelaEnv,
  ) {
    this.#invocationSecret = invocationSecret;
    this.#urlSecret = urlSecret;
    this.#env = env;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const token = request.headers.get(INVOCATION_HEADER);
    if (!token) throw new ForbiddenException(INVALID);

    const secret = resolveSigningSecret(this.#invocationSecret, this.#urlSecret, this.#env);

    // Verifies parse → aud → expiry → signature (constant-time), fail-closed.
    const claim = await verifyInvocation(token, secret);
    if (!claim) throw new ForbiddenException(INVALID);

    // Bind the authenticated claim to THIS request. The signature already
    // covers these fields; re-checking them against the live request closes
    // "sign for A, replay against B".
    if (claim.method !== request.method) throw new ForbiddenException(INVALID);

    const url = new URL(request.url);
    if (claim.path !== `${url.pathname}${url.search}`) throw new ForbiddenException(INVALID);

    // The capture middleware installed by `@SignedInvocation()` hashes the raw
    // body before the guard. HTTP now runs guards before argument extraction,
    // so the fallback can also hash the still-unconsumed live body safely.
    // `takeCapturedBodyHash` clears the entry to prevent stale Request reuse.
    const captured = takeCapturedBodyHash(request);
    const bodyHash = captured !== undefined ? captured : await hashLiveBody(request);
    if (claim.bodyHash !== bodyHash) throw new ForbiddenException(INVALID);

    // Single-use: reject a replay of the same nonce (per-isolate for the default
    // MemoryNonceStore — see NonceStore docs). No store ⇒ nonce is advisory.
    if (this.nonceStore) {
      const fresh = await this.nonceStore.claim(claim.nonce, claim.exp);
      if (!fresh) throw new ForbiddenException(INVALID);
    }

    return true;
  }
}

// Built by the pipeline for `@SignedInvocation()` routes in any module.
declareRootDefault(SignedInvocationGuard);

/**
 * Guards a route with {@link SignedInvocationGuard} — the request must carry a
 * valid, unexpired, single-use invocation token whose bound method/path/body
 * match. Pair with {@link InternalDispatcher.run} on the calling side.
 *
 * ```ts
 * @Post('reindex', { name: 'search.reindex' })
 * @SignedInvocation()
 * reindex(@Body() body: ReindexJob) { ... }
 * ```
 *
 * Composes {@link SignedInvocationBodyCapture} ahead of the guard so body
 * hashing remains stable even when earlier scoped middleware observes the
 * request. The application's outer body limit runs before this middleware.
 */
export function SignedInvocation(): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    UseMiddleware(SignedInvocationBodyCapture),
    UseGuards(SignedInvocationGuard),
  );
}
