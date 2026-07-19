/**
 * Confirm-token signer for destructive ops. A destructive op must carry a
 * `confirmToken` bound to (op, payload) so a two-step confirm cannot be
 * replayed against a different op or mutated payload. HMAC over
 * `{ op, payloadHash, exp }`; payload is hashed (SHA-256, canonical JSON) so
 * the token never embeds the raw payload. TTL ~5 min.
 */
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalJson,
  deriveHmacKey,
  fromUtf8,
  hmacSign,
  sha256,
  utf8,
} from './crypto';
import { timingSafeEqual } from './token-compare';

interface ConfirmClaims {
  op: string;
  payloadHash: string;
  /** Absolute expiry, unix seconds. */
  exp: number;
}

export interface ConfirmTokenSignerOptions {
  /** Token lifetime in seconds (default 300 = 5 min). */
  ttlSec?: number;
  /** Injectable clock (ms epoch) for deterministic tests. */
  now?: () => number;
}

const HKDF_INFO = 'vela:studio:confirm-token:v1';

export class ConfirmTokenSigner {
  private keyPromise?: Promise<CryptoKey>;

  constructor(
    private readonly secret: string,
    private readonly options: ConfirmTokenSignerOptions = {},
  ) {}

  private key(): Promise<CryptoKey> {
    return (this.keyPromise ??= deriveHmacKey(this.secret, HKDF_INFO));
  }

  private nowSec(): number {
    return Math.floor((this.options.now ? this.options.now() : Date.now()) / 1000);
  }

  private async hashPayload(payload: unknown): Promise<string> {
    return base64UrlEncode(await sha256(utf8(canonicalJson(payload ?? {}))));
  }

  /** Issue a confirm-token for `(op, payload)`. Returns the token + absolute expiry. */
  async issue(op: string, payload: unknown): Promise<{ token: string; exp: number }> {
    const exp = this.nowSec() + (this.options.ttlSec ?? 300);
    const claims: ConfirmClaims = { op, payloadHash: await this.hashPayload(payload), exp };
    const body = base64UrlEncode(utf8(JSON.stringify(claims)));
    const sig = base64UrlEncode(await hmacSign(await this.key(), utf8(body)));
    return { token: `${body}.${sig}`, exp };
  }

  /** True iff `token` is a valid, unexpired confirm for exactly this `(op, payload)`. */
  async verify(op: string, payload: unknown, token: string): Promise<boolean> {
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expectedSig = base64UrlEncode(await hmacSign(await this.key(), utf8(body)));
    if (!(await timingSafeEqual(sig, expectedSig))) return false;

    const raw = base64UrlDecode(body);
    if (!raw) return false;
    let claims: ConfirmClaims;
    try {
      claims = JSON.parse(fromUtf8(raw)) as ConfirmClaims;
    } catch {
      return false;
    }
    if (claims.op !== op) return false;
    if (typeof claims.exp !== 'number' || claims.exp < this.nowSec()) return false;
    const expectedHash = await this.hashPayload(payload);
    return timingSafeEqual(claims.payloadHash, expectedHash);
  }
}
