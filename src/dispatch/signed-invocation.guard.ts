import { CONFIG_ENV } from '../config/config.tokens';
import { Inject, Injectable, Optional } from '../container/decorators';
import { sha256Base64Url } from '../crypto/hmac';
import { verifyInvocation } from '../crypto/invocation';
import { ForbiddenException } from '../errors/http-exception';
import { applyDecorators } from '../http/decorators';
import { URL_SIGNING_SECRET, resolveSigningSecret } from '../http/url/signing-secret';
import { UseGuards } from '../pipeline/decorators';
import type { CanActivate, ExecutionContext } from '../pipeline/types';
import { INVOCATION_HEADER, INVOCATION_SIGNING_SECRET, NONCE_STORE } from './tokens';
import type { NonceStore } from './types';

// One opaque, generic 403 for EVERY failure mode — a missing/tampered/expired
// token, a method/path/body mismatch, or a replayed nonce all look identical to
// a caller, so nothing leaks which check tripped (and never the secret).
const INVALID = 'Invalid or expired invocation';

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
  constructor(
    @Optional() @Inject(INVOCATION_SIGNING_SECRET) private readonly invocationSecret?: string,
    @Optional() @Inject(URL_SIGNING_SECRET) private readonly urlSecret?: string,
    @Optional() @Inject(NONCE_STORE) private readonly nonceStore?: NonceStore,
    @Optional() @Inject(CONFIG_ENV) private readonly env: Record<string, unknown> = {},
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const token = request.headers.get(INVOCATION_HEADER);
    if (!token) throw new ForbiddenException(INVALID);

    const secret = resolveSigningSecret(this.invocationSecret, this.urlSecret, this.env);

    // Verifies parse → aud → expiry → signature (constant-time), fail-closed.
    const claim = await verifyInvocation(token, secret);
    if (!claim) throw new ForbiddenException(INVALID);

    // Bind the authenticated claim to THIS request. The signature already
    // covers these fields; re-checking them against the live request closes
    // "sign for A, replay against B".
    if (claim.method !== request.method) throw new ForbiddenException(INVALID);

    const url = new URL(request.url);
    if (claim.path !== `${url.pathname}${url.search}`) throw new ForbiddenException(INVALID);

    const bodyBytes = new Uint8Array(await request.clone().arrayBuffer());
    const bodyHash = bodyBytes.byteLength === 0 ? '' : await sha256Base64Url(bodyBytes);
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
 */
export function SignedInvocation(): ReturnType<typeof applyDecorators> {
  return applyDecorators(UseGuards(SignedInvocationGuard));
}
