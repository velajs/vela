/**
 * Confirm-token signer for destructive ops. A destructive op must carry a
 * `confirmToken` bound to (op, payload) so a two-step confirm cannot be
 * replayed against a different op or mutated payload. HMAC over
 * `{ op, payloadHash, nonce, exp }`; payload is hashed (SHA-256, canonical JSON)
 * so the token never embeds the raw payload. TTL ~5 min.
 *
 * Every token additionally carries a random `nonce`. {@link ConfirmTokenSigner.verify}
 * is a STATELESS validity check (signature + op + expiry + payload binding).
 * {@link ConfirmTokenSigner.verifyAndConsume} adds SINGLE-USE replay protection:
 * it records the nonce in a bounded used-set so the same token can never be
 * spent twice (closing the M2 replay note). The used-set is bounded (the M2
 * bounded-map idiom) — expired nonces are pruned and the oldest is evicted past
 * the cap, so a flood of confirms cannot grow it without bound.
 */
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalJson,
  deriveHmacKey,
  fromUtf8,
  hmacSign,
  randomToken,
  sha256,
  utf8,
} from './crypto';
import { timingSafeEqual } from './token-compare';

interface ConfirmClaims {
  op: string;
  payloadHash: string;
  /** Single-use nonce — the key the used-set records to reject replays. */
  nonce: string;
  /** Absolute expiry, unix seconds. */
  exp: number;
}

export interface ConfirmTokenSignerOptions {
  /** Token lifetime in seconds (default 300 = 5 min). */
  ttlSec?: number;
  /** Injectable clock (ms epoch) for deterministic tests. */
  now?: () => number;
  /** Max retained used-nonces before oldest-eviction (default 1024). */
  maxUsedNonces?: number;
}

const HKDF_INFO = 'vela:studio:confirm-token:v1';
const DEFAULT_MAX_USED_NONCES = 1024;

export class ConfirmTokenSigner {
  private keyPromise?: Promise<CryptoKey>;
  /** Spent nonces → their expiry (unix seconds), for single-use enforcement. */
  private readonly usedNonces = new Map<string, number>();

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
    const claims: ConfirmClaims = {
      op,
      payloadHash: await this.hashPayload(payload),
      nonce: randomToken(),
      exp,
    };
    const body = base64UrlEncode(utf8(JSON.stringify(claims)));
    const sig = base64UrlEncode(await hmacSign(await this.key(), utf8(body)));
    return { token: `${body}.${sig}`, exp };
  }

  /**
   * True iff `token` is a valid, unexpired confirm for exactly this `(op,
   * payload)`. STATELESS — it does not consume the token; use
   * {@link verifyAndConsume} for single-use replay protection.
   */
  async verify(op: string, payload: unknown, token: string): Promise<boolean> {
    return (await this.parse(op, payload, token)) !== null;
  }

  /**
   * True iff `token` is a valid confirm for `(op, payload)` AND its nonce has
   * not been spent before. On success the nonce is recorded, so a second call
   * with the same token returns false (single-use). Invalid tokens never
   * touch the used-set.
   */
  async verifyAndConsume(op: string, payload: unknown, token: string): Promise<boolean> {
    const claims = await this.parse(op, payload, token);
    if (claims === null) return false;
    this.pruneExpired();
    if (this.usedNonces.has(claims.nonce)) return false;
    this.remember(claims.nonce, claims.exp);
    return true;
  }

  /** Parse + fully verify a token, returning its claims or `null` when invalid. */
  private async parse(op: string, payload: unknown, token: string): Promise<ConfirmClaims | null> {
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expectedSig = base64UrlEncode(await hmacSign(await this.key(), utf8(body)));
    if (!(await timingSafeEqual(sig, expectedSig))) return null;

    const raw = base64UrlDecode(body);
    if (!raw) return null;
    let claims: ConfirmClaims;
    try {
      claims = JSON.parse(fromUtf8(raw)) as ConfirmClaims;
    } catch {
      return null;
    }
    if (claims.op !== op) return null;
    if (typeof claims.nonce !== 'string' || claims.nonce.length === 0) return null;
    if (typeof claims.exp !== 'number' || claims.exp < this.nowSec()) return null;
    const expectedHash = await this.hashPayload(payload);
    return (await timingSafeEqual(claims.payloadHash, expectedHash)) ? claims : null;
  }

  /** Record a spent nonce, evicting the oldest entry past the cap. */
  private remember(nonce: string, exp: number): void {
    const max = this.options.maxUsedNonces ?? DEFAULT_MAX_USED_NONCES;
    if (this.usedNonces.size >= max) {
      const oldest = this.usedNonces.keys().next().value;
      if (oldest !== undefined) this.usedNonces.delete(oldest);
    }
    this.usedNonces.set(nonce, exp);
  }

  /** Drop nonces whose tokens have already expired (they can no longer verify). */
  private pruneExpired(): void {
    const now = this.nowSec();
    for (const [nonce, exp] of this.usedNonces) {
      if (exp < now) this.usedNonces.delete(nonce);
    }
  }
}
