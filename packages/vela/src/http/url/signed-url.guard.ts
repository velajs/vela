import { Injectable, Inject, Optional } from '../../container/decorators';
import { declareRootDefault } from '../../container/root-defaults';
import { HTTP_SIGNED_URL_PURPOSE, verifySignedUrl } from '../../crypto/signed-url';
import { InjectEnv, type VelaEnv } from '../../env';
import { ForbiddenException } from '../../errors/http-exception';
import { applyDecorators } from '../decorators';
import { UseGuards } from '../../pipeline/decorators';
import type { CanActivate, ExecutionContext } from '../../pipeline/types';
import { URL_SIGNING_SECRET, resolveSigningSecret } from './signing-secret';

/**
 * Verifies the HMAC signature (and `expires`) of the incoming request URL,
 * using the same secret source as {@link UrlGeneratorService.signedUrl}: the
 * {@link URL_SIGNING_SECRET} token, else the string `ENV.URL_SIGNING_SECRET`.
 * Throws `ForbiddenException` (403) when the signature is missing, tampered,
 * or expired. Registered app-wide by `bootstrap`; apply it per-route with
 * {@link SignedUrl}.
 */
@Injectable()
export class SignedUrlGuard implements CanActivate {
  readonly #secretToken: string | undefined;
  readonly #env: VelaEnv | undefined;

  constructor(
    @Optional() @Inject(URL_SIGNING_SECRET) secretToken?: string,
    @Optional() @InjectEnv() env?: VelaEnv,
  ) {
    this.#secretToken = secretToken;
    this.#env = env;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const secret = resolveSigningSecret(undefined, this.#secretToken, this.#env);
    const valid = await verifySignedUrl(request.url, secret, {
      method: request.method,
      purpose: HTTP_SIGNED_URL_PURPOSE,
    });
    if (!valid) {
      throw new ForbiddenException('Invalid or expired signed URL');
    }
    return true;
  }
}

// Built by the pipeline for `@SignedUrl()` routes in any module.
declareRootDefault(SignedUrlGuard);

/**
 * Guards a route with {@link SignedUrlGuard} — the request must carry a valid,
 * unexpired HMAC signature (produced by `UrlGeneratorService.signedUrl`).
 *
 * ```ts
 * @Get('download', { name: 'file.download' })
 * @SignedUrl()
 * download() { ... }
 * ```
 */
export function SignedUrl(): ReturnType<typeof applyDecorators> {
  return applyDecorators(UseGuards(SignedUrlGuard));
}
