import { InjectionToken } from '../../container/types';

/**
 * Optional DI token holding the HMAC secret used to sign / verify URLs. Provide
 * it globally (e.g. from a platform adapter or a `@Global` module) so both
 * {@link UrlGeneratorService} and the signed-URL guard can read it:
 *
 * ```ts
 * { provide: URL_SIGNING_SECRET, useValue: env.URL_SIGNING_SECRET }
 * ```
 */
export const URL_SIGNING_SECRET = new InjectionToken<string>('URL_SIGNING_SECRET');

/** Key read from `CONFIG_ENV` when no explicit secret / token is available. */
export const URL_SIGNING_SECRET_ENV_KEY = 'URL_SIGNING_SECRET';

/**
 * Resolve the signing secret from, in order: an explicit argument, the
 * {@link URL_SIGNING_SECRET} token, then `CONFIG_ENV[URL_SIGNING_SECRET]`.
 * Throws a descriptive error when none is available — signing must never fall
 * back to an empty/implicit key.
 */
export function resolveSigningSecret(
  explicit: string | undefined,
  token: string | undefined,
  env: Record<string, unknown> | undefined,
): string {
  const fromEnv = env?.[URL_SIGNING_SECRET_ENV_KEY];
  const secret = explicit ?? token ?? (typeof fromEnv === 'string' ? fromEnv : undefined);
  if (!secret) {
    throw new Error(
      'No URL signing secret is available. Pass one explicitly, register a ' +
        '`URL_SIGNING_SECRET` provider, or set `URL_SIGNING_SECRET` in `CONFIG_ENV`.',
    );
  }
  return secret;
}
