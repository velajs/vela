/**
 * Ephemeral WS sub-token signer. The master bearer never leaves the server;
 * short-lived sub-tokens (minted at `POST {p}/ws-token`) authorize a live/WS
 * connection scoped to a room. HKDF-derives an HMAC key from the master and
 * signs `base64url(JSON claims)`; verify checks signature then expiry.
 */
import {
  base64UrlDecode,
  base64UrlEncode,
  deriveHmacKey,
  fromUtf8,
  hmacSign,
  randomToken,
  utf8,
} from './crypto';
import { timingSafeEqual } from './token-compare';

/** Claims carried by a minted sub-token. */
export interface SubTokenClaims {
  scope: 'live';
  room?: string;
  /** Absolute expiry, unix seconds. */
  exp: number;
  /** Random per-token nonce (replay/dedup aid). */
  nonce: string;
}

/** Inputs a caller supplies when minting; `exp`/`nonce` are server-assigned. */
export interface MintSubTokenInput {
  scope: 'live';
  room?: string;
}

export interface AdminSubTokenSignerOptions {
  /** Default token lifetime in seconds (default 300). */
  ttlSec?: number;
  /** Injectable clock (ms epoch) for deterministic tests. */
  now?: () => number;
}

const HKDF_INFO = 'vela:studio:sub-token:v1';

export class AdminSubTokenSigner {
  private keyPromise?: Promise<CryptoKey>;

  constructor(
    private readonly secret: string,
    private readonly options: AdminSubTokenSignerOptions = {},
  ) {}

  private key(): Promise<CryptoKey> {
    return (this.keyPromise ??= deriveHmacKey(this.secret, HKDF_INFO));
  }

  private nowSec(): number {
    return Math.floor((this.options.now ? this.options.now() : Date.now()) / 1000);
  }

  /** Mint a signed sub-token. Returns the wire token and its absolute expiry. */
  async mint(input: MintSubTokenInput, ttlSec?: number): Promise<{ token: string; exp: number }> {
    const exp = this.nowSec() + (ttlSec ?? this.options.ttlSec ?? 300);
    const claims: SubTokenClaims = {
      scope: input.scope,
      ...(input.room !== undefined ? { room: input.room } : {}),
      exp,
      nonce: randomToken(12),
    };
    const payload = base64UrlEncode(utf8(JSON.stringify(claims)));
    const sig = base64UrlEncode(await hmacSign(await this.key(), utf8(payload)));
    return { token: `${payload}.${sig}`, exp };
  }

  /** Verify signature + expiry; returns the claims or `null` when invalid/expired. */
  async verify(token: string): Promise<SubTokenClaims | null> {
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = base64UrlEncode(await hmacSign(await this.key(), utf8(payload)));
    if (!(await timingSafeEqual(sig, expected))) return null;

    const raw = base64UrlDecode(payload);
    if (!raw) return null;
    let claims: SubTokenClaims;
    try {
      claims = JSON.parse(fromUtf8(raw)) as SubTokenClaims;
    } catch {
      return null;
    }
    if (typeof claims.exp !== 'number' || claims.exp < this.nowSec()) return null;
    if (claims.scope !== 'live') return null;
    return claims;
  }
}
