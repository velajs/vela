import type { IssuerPreset } from './types';

/** Path, relative to the team origin, where Access serves its public signing keys. */
const ACCESS_CERTS_PATH = '/cdn-cgi/access/certs';
/** Name of the request header Access injects with the signed assertion. */
const ACCESS_HEADER = 'cf-access-jwt-assertion';
/** Name of the cookie Access writes for full-page browser loads. */
const ACCESS_COOKIE = 'CF_Authorization';
/** Suffix appended to a bare team name to form its full host. */
const ACCESS_HOST_SUFFIX = '.cloudflareaccess.com';

/** Drop any trailing `/` characters using a linear scan (no regex, so ReDoS-proof). */
const trimTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') end -= 1;
  return value.slice(0, end);
};

/** Remove a leading `http://` / `https://` prefix, ignoring case. */
const stripScheme = (value: string): string => {
  const lower = value.toLowerCase();
  if (lower.startsWith('https://')) return value.slice(8);
  if (lower.startsWith('http://')) return value.slice(7);
  return value;
};

/**
 * Turn whatever form the team domain was configured in into the one canonical
 * issuer origin the `iss` claim will be matched against.
 *
 * Callers may hand in just the team slug (`acme`), the resolved host
 * (`acme.cloudflareaccess.com`), or an entire URL; the output is always
 * `https://<host>` with the host lower-cased and nothing trailing. A slug with no
 * dot is grown into its full `cloudflareaccess.com` host first. Everything is fed
 * through `URL` and reduced to the origin, which discards any accidental path
 * segment so it cannot leak into the issuer string. An empty input is an error.
 */
export const cloudflareAccessIssuer = (teamDomain: string): IssuerPreset => {
  const trimmed = trimTrailingSlashes(stripScheme(teamDomain.trim()));
  if (trimmed.length === 0) {
    throw new Error(
      '@velajs/cloudflare-access: teamDomain is required (e.g. "acme" or "acme.cloudflareaccess.com")',
    );
  }

  const candidate = trimmed.includes('.')
    ? `https://${trimmed}`
    : `https://${trimmed}${ACCESS_HOST_SUFFIX}`;
  const host = new URL(candidate).host.toLowerCase();
  const issuer = `https://${host}`;

  return {
    issuer,
    jwksUri: `${issuer}${ACCESS_CERTS_PATH}`,
    algorithms: ['RS256'],
    header: ACCESS_HEADER,
    cookie: ACCESS_COOKIE,
  };
};

/** Configuration for {@link genericOidcIssuer}. */
export interface GenericOidcConfig {
  /** The exact `iss` value tokens carry. */
  issuer: string;
  /** JWKS document URL. Defaults to `${issuer}/.well-known/jwks.json`. */
  jwksUri?: string;
  /** Accepted signature algorithms. Defaults to `['RS256']`. */
  algorithms?: readonly string[];
  /** Header carrying the token. Defaults to `authorization` (with `bearer: true`). */
  header?: string;
  /** Cookie fallback name. Omitted by default. */
  cookie?: string;
  /** Whether to strip a `Bearer ` prefix from the header value. Defaults to `true` for the default header. */
  bearer?: boolean;
}

/**
 * Build a preset for a generic OIDC / JWKS issuer, generalizing the Cloudflare
 * wire constants: an explicit issuer, the conventional `/.well-known/jwks.json`
 * JWKS path, RS256 pinning, and an `Authorization: Bearer <jwt>` read by default.
 * This is what lets the package serve any standards-compliant issuer, not only
 * Cloudflare Access. Throws on an empty issuer.
 */
export const genericOidcIssuer = (config: GenericOidcConfig): IssuerPreset => {
  const issuer = trimTrailingSlashes(config.issuer.trim());
  if (issuer.length === 0) {
    throw new Error('@velajs/cloudflare-access: genericOidcIssuer requires a non-empty issuer');
  }

  const header = config.header ?? 'authorization';
  // Default the Bearer-strip on only when the caller left the header as the
  // Authorization default; a custom header defaults to a raw token unless the
  // caller opts in.
  const bearer = config.bearer ?? config.header === undefined;

  const preset: IssuerPreset = {
    issuer,
    jwksUri: config.jwksUri ?? `${issuer}/.well-known/jwks.json`,
    algorithms: config.algorithms ?? ['RS256'],
    header,
    bearer,
  };
  if (config.cookie !== undefined) preset.cookie = config.cookie;
  return preset;
};
