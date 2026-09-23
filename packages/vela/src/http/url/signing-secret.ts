import { InjectionToken } from '../../container/types';
import { readEnvString, type VelaEnv } from '../../env';

/**
 * Optional DI token holding the HMAC secret used to sign / verify URLs. Without
 * a provider, {@link UrlGeneratorService} and the signed-URL guard read the
 * `URL_SIGNING_SECRET` string from `ENV`, such as a Workers secret. Provide the
 * token to take the secret from elsewhere:
 *
 * ```ts
 * @Module({
 *   providers: [
 *     defineProvider(URL_SIGNING_SECRET, {
 *       inject: [SecretStore],
 *       useFactory: (store) => store.read('url-signing'),
 *     }),
 *   ],
 * })
 * ```
 */
export const URL_SIGNING_SECRET = /* @__PURE__ */ new InjectionToken<string>('URL_SIGNING_SECRET');

/** Key read from `ENV` when no explicit secret / token is available. */
export const URL_SIGNING_SECRET_ENV_KEY = 'URL_SIGNING_SECRET';

/**
 * Resolve the signing secret from, in order: an explicit argument, the
 * {@link URL_SIGNING_SECRET} token, then the string `ENV.URL_SIGNING_SECRET`
 * (a Workers secret, for example). Throws a descriptive error when none is
 * available — signing must never fall back to an empty/implicit key.
 */
export function resolveSigningSecret(
  explicit: string | undefined,
  token: string | undefined,
  env: VelaEnv | undefined,
): string {
  const secret = explicit ?? token ?? readEnvString(env, URL_SIGNING_SECRET_ENV_KEY);
  if (!secret) {
    throw new Error(
      'No URL signing secret is available. Pass one explicitly, register a ' +
        '`URL_SIGNING_SECRET` provider, or set the `URL_SIGNING_SECRET` variable in ENV.',
    );
  }
  return secret;
}
