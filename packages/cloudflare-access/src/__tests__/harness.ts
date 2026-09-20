import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';

/** An RS256 keypair plus a self-hosted local JWKS getter over its public key. */
export interface TestKeyMaterial {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  kid: string;
  /** A `jose` local JWKS getter — pass as `keySet` for a network-free verify. */
  jwks: JWTVerifyGetKey;
}

/** Generate an extractable RS256 keypair and a local JWKS over the public key. */
export const makeKeyMaterial = async (kid = 'kid-test-1'): Promise<TestKeyMaterial> => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
  return { publicKey, privateKey, kid, jwks };
};

/** How to mint a test token. */
export interface MintOptions {
  privateKey: CryptoKey;
  issuer: string;
  audience: string | string[];
  kid?: string;
  subject?: string;
  /** Extra claims merged into the payload (email, common_name, groups, …). */
  claims?: Record<string, unknown>;
  /** Expiry — a `jose` duration string or an absolute epoch-seconds number. Default `'5m'`. */
  expiresAt?: string | number;
  /** Not-before — a `jose` duration string or an absolute epoch-seconds number. */
  notBefore?: string | number;
}

/** Mint a valid RS256 compact JWT with the given claims. */
export const mintToken = async (options: MintOptions): Promise<string> => {
  const header: { alg: string; kid?: string } = { alg: 'RS256' };
  if (options.kid !== undefined) header.kid = options.kid;

  const jwt = new SignJWT({ ...options.claims })
    .setProtectedHeader(header)
    .setIssuedAt()
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setExpirationTime(options.expiresAt ?? '5m');
  if (options.subject !== undefined) jwt.setSubject(options.subject);
  if (options.notBefore !== undefined) jwt.setNotBefore(options.notBefore);
  return jwt.sign(options.privateKey);
};

/** Mint an HS256-signed token (used to prove the RS256 pin rejects it). */
export const mintHs256Token = async (
  secret: Uint8Array,
  options: Omit<MintOptions, 'privateKey' | 'kid'>,
): Promise<string> =>
  new SignJWT({ ...options.claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setExpirationTime(options.expiresAt ?? '5m')
    .sign(secret);

/**
 * Flip the FIRST base64url character of the compact JWT's signature segment,
 * changing it to a different valid base64url char so the token stays
 * structurally parseable but the signature no longer verifies.
 */
export const tamperSignature = (jwt: string): string => {
  const parts = jwt.split('.');
  const sig = parts[2];
  if (parts.length !== 3 || sig === undefined || sig.length === 0) {
    throw new Error('harness: expected a three-segment compact JWT');
  }
  const first = sig.charAt(0);
  const replacement = first === 'A' ? 'B' : 'A';
  parts[2] = replacement + sig.slice(1);
  return parts.join('.');
};

/** Build a `Request` carrying `token` under `header`. */
export const requestWithHeader = (
  header: string,
  token: string,
  url = 'https://app.example.com/',
): Request => new Request(url, { headers: { [header]: token } });

/** Build a `Request` carrying `token` in a named cookie. */
export const requestWithCookie = (
  cookieName: string,
  token: string,
  url = 'https://app.example.com/',
): Request => new Request(url, { headers: { cookie: `${cookieName}=${token}` } });
