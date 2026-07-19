import { describe, expect, it } from 'vitest';
import { timingSafeEqual } from '../src/security/token-compare';
import { AdminSubTokenSigner } from '../src/security/sub-token.signer';
import { ConfirmTokenSigner } from '../src/security/confirm-token';
import { FixedWindowCounter, RateLimiter } from '../src/http/middleware/rate-limit';
import { base64UrlDecode, base64UrlEncode, canonicalJson } from '../src/security/crypto';

describe('timingSafeEqual', () => {
  it('is true for identical strings', async () => {
    expect(await timingSafeEqual('s3cr3t-token', 's3cr3t-token')).toBe(true);
  });

  it('is false for different strings (equal length)', async () => {
    expect(await timingSafeEqual('aaaaaaaa', 'aaaaaaab')).toBe(false);
  });

  it('is false for different-length strings without leaking length', async () => {
    expect(await timingSafeEqual('short', 'a-much-longer-secret')).toBe(false);
  });

  it('is true for empty vs empty', async () => {
    expect(await timingSafeEqual('', '')).toBe(true);
  });
});

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const decoded = base64UrlDecode(base64UrlEncode(bytes));
    expect(decoded).not.toBeNull();
    expect([...(decoded ?? [])]).toEqual([...bytes]);
  });

  it('returns null on malformed input (out-of-alphabet characters)', () => {
    expect(base64UrlDecode('!!!not base64!!!')).toBeNull();
  });

  it('returns null on input a forgiving atob would tolerate (embedded whitespace)', () => {
    // atob silently ignores ASCII whitespace and would decode these to bytes;
    // the strict decoder must reject anything outside the base64url alphabet.
    expect(base64UrlDecode('  spaces  ')).toBeNull();
    expect(base64UrlDecode('Zm9v YmFy')).toBeNull();
    expect(base64UrlDecode('Zm9v\nYmFy')).toBeNull();
  });

  it('canonicalizes object key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
});

describe('AdminSubTokenSigner', () => {
  it('mint -> verify round-trips claims', async () => {
    const signer = new AdminSubTokenSigner('master-secret');
    const { token, exp } = await signer.mint({ scope: 'live', room: 'room-42' });
    const claims = await signer.verify(token);
    expect(claims).not.toBeNull();
    expect(claims?.scope).toBe('live');
    expect(claims?.room).toBe('room-42');
    expect(claims?.exp).toBe(exp);
    expect(typeof claims?.nonce).toBe('string');
  });

  it('rejects an expired token', async () => {
    let now = 1_000_000_000_000;
    const signer = new AdminSubTokenSigner('master-secret', { ttlSec: 60, now: () => now });
    const { token } = await signer.mint({ scope: 'live' });
    now += 61_000; // advance past expiry
    expect(await signer.verify(token)).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const signer = new AdminSubTokenSigner('master-secret');
    const { token } = await signer.mint({ scope: 'live', room: 'r' });
    const tampered = `${token.slice(0, -2)}xy`;
    expect(await signer.verify(tampered)).toBeNull();
  });

  it('rejects a token signed by a different master', async () => {
    const a = new AdminSubTokenSigner('secret-a');
    const b = new AdminSubTokenSigner('secret-b');
    const { token } = await a.mint({ scope: 'live' });
    expect(await b.verify(token)).toBeNull();
  });

  it('rejects garbage', async () => {
    const signer = new AdminSubTokenSigner('master-secret');
    expect(await signer.verify('not-a-token')).toBeNull();
    expect(await signer.verify('')).toBeNull();
  });
});

describe('ConfirmTokenSigner', () => {
  it('issue -> verify succeeds for the same op + payload', async () => {
    const signer = new ConfirmTokenSigner('master-secret');
    const payload = { model: 'User', ids: ['1', '2'] };
    const { token } = await signer.issue('data.deleteRows', payload);
    expect(await signer.verify('data.deleteRows', payload, token)).toBe(true);
  });

  it('verify is order-insensitive on payload keys', async () => {
    const signer = new ConfirmTokenSigner('master-secret');
    const { token } = await signer.issue('data.clearTable', { model: 'User', hard: true });
    expect(await signer.verify('data.clearTable', { hard: true, model: 'User' }, token)).toBe(true);
  });

  it('rejects a token bound to a different op', async () => {
    const signer = new ConfirmTokenSigner('master-secret');
    const { token } = await signer.issue('data.deleteRows', { id: '1' });
    expect(await signer.verify('data.clearTable', { id: '1' }, token)).toBe(false);
  });

  it('rejects when the payload was tampered', async () => {
    const signer = new ConfirmTokenSigner('master-secret');
    const { token } = await signer.issue('data.deleteRows', { ids: ['1'] });
    expect(await signer.verify('data.deleteRows', { ids: ['1', '2'] }, token)).toBe(false);
  });

  it('rejects an expired confirm-token', async () => {
    let now = 2_000_000_000_000;
    const signer = new ConfirmTokenSigner('master-secret', { ttlSec: 30, now: () => now });
    const { token } = await signer.issue('data.deleteRows', { id: '1' });
    now += 31_000;
    expect(await signer.verify('data.deleteRows', { id: '1' }, token)).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const signer = new ConfirmTokenSigner('master-secret');
    const { token } = await signer.issue('data.deleteRows', { id: '1' });
    expect(await signer.verify('data.deleteRows', { id: '1' }, `${token}z`)).toBe(false);
  });

  it('mints a distinct token per issue (the single-use nonce)', async () => {
    const signer = new ConfirmTokenSigner('master-secret');
    const payload = { model: 'User', ids: ['1'] };
    const a = await signer.issue('data.deleteRows', payload);
    const b = await signer.issue('data.deleteRows', payload);
    // Same op + payload + exp, yet different tokens: the nonce differs.
    expect(a.token).not.toBe(b.token);
    // Both are individually valid.
    expect(await signer.verify('data.deleteRows', payload, a.token)).toBe(true);
    expect(await signer.verify('data.deleteRows', payload, b.token)).toBe(true);
  });
});

describe('ConfirmTokenSigner single-use (replay protection)', () => {
  it('verifyAndConsume succeeds once, then rejects the replayed token', async () => {
    const signer = new ConfirmTokenSigner('master-secret');
    const payload = { model: 'User', ids: ['1', '2'] };
    const { token } = await signer.issue('data.deleteRows', payload);
    // First spend succeeds...
    expect(await signer.verifyAndConsume('data.deleteRows', payload, token)).toBe(true);
    // ...the identical token cannot be spent again.
    expect(await signer.verifyAndConsume('data.deleteRows', payload, token)).toBe(false);
  });

  it('verify() stays stateless — it never consumes the nonce', async () => {
    const signer = new ConfirmTokenSigner('master-secret');
    const payload = { model: 'User' };
    const { token } = await signer.issue('data.clearTable', payload);
    // Stateless validity check is idempotent...
    expect(await signer.verify('data.clearTable', payload, token)).toBe(true);
    expect(await signer.verify('data.clearTable', payload, token)).toBe(true);
    // ...and does not spend the token, so a later consume still works exactly once.
    expect(await signer.verifyAndConsume('data.clearTable', payload, token)).toBe(true);
    expect(await signer.verifyAndConsume('data.clearTable', payload, token)).toBe(false);
  });

  it('an invalid token never poisons the used-set', async () => {
    const signer = new ConfirmTokenSigner('master-secret');
    const payload = { model: 'User', ids: ['1'] };
    const { token } = await signer.issue('data.deleteRows', payload);
    // A consume against the WRONG payload fails and records nothing...
    expect(
      await signer.verifyAndConsume('data.deleteRows', { model: 'User', ids: ['2'] }, token),
    ).toBe(false);
    // ...so the genuine (op, payload) can still be spent once.
    expect(await signer.verifyAndConsume('data.deleteRows', payload, token)).toBe(true);
    expect(await signer.verifyAndConsume('data.deleteRows', payload, token)).toBe(false);
  });

  it('bounds the used-nonce set (oldest-eviction under a flood)', async () => {
    const signer = new ConfirmTokenSigner('master-secret', { maxUsedNonces: 8 });
    for (let i = 0; i < 100; i++) {
      const payload = { model: 'User', ids: [String(i)] };
      const { token } = await signer.issue('data.deleteRows', payload);
      expect(await signer.verifyAndConsume('data.deleteRows', payload, token)).toBe(true);
    }
    // The oldest nonces have been evicted; a just-spent token is not resurrected
    // as spendable (the LAST consume above already proved single-use holds).
    const payload = { model: 'User', ids: ['fresh'] };
    const { token } = await signer.issue('data.deleteRows', payload);
    expect(await signer.verifyAndConsume('data.deleteRows', payload, token)).toBe(true);
    expect(await signer.verifyAndConsume('data.deleteRows', payload, token)).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('allows up to max then denies', () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 60_000, max: 3 }, () => now);
    expect(limiter.check('ip-1')).toBe(true);
    expect(limiter.check('ip-1')).toBe(true);
    expect(limiter.check('ip-1')).toBe(true);
    expect(limiter.check('ip-1')).toBe(false);
  });

  it('buckets are per-key', () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1 }, () => now);
    expect(limiter.check('ip-1')).toBe(true);
    expect(limiter.check('ip-1')).toBe(false);
    expect(limiter.check('ip-2')).toBe(true);
  });

  it('refills over time', () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 1000, max: 1 }, () => now);
    expect(limiter.check('ip-1')).toBe(true);
    expect(limiter.check('ip-1')).toBe(false);
    now += 1000; // one full window later -> one token back
    expect(limiter.check('ip-1')).toBe(true);
  });

  it('bounds its map under many distinct spoofed IPs (idle eviction)', () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 1000, max: 5, maxEntries: 10 }, () => now);
    // A flood of distinct source IPs, the clock advancing so older entries age
    // out of the window and become evictable. Without the cap this map would
    // hold ~1000 entries; with it, it stays bounded.
    for (let i = 0; i < 1000; i++) {
      now += 200; // window is 1000ms => an entry is idle after 5 inserts
      limiter.check(`ip-${i}`);
    }
    expect(limiter.size).toBeLessThanOrEqual(11); // maxEntries + the just-inserted key
  });
});

describe('FixedWindowCounter (pre-auth throttle)', () => {
  it('allows up to max per window, then denies', () => {
    let now = 0;
    const counter = new FixedWindowCounter({ windowMs: 1000, max: 3 }, () => now);
    expect(counter.check('ip-1')).toBe(true);
    expect(counter.check('ip-1')).toBe(true);
    expect(counter.check('ip-1')).toBe(true);
    expect(counter.check('ip-1')).toBe(false);
  });

  it('rolls over when the window elapses', () => {
    let now = 0;
    const counter = new FixedWindowCounter({ windowMs: 1000, max: 1 }, () => now);
    expect(counter.check('ip-1')).toBe(true);
    expect(counter.check('ip-1')).toBe(false);
    now += 1000; // new window
    expect(counter.check('ip-1')).toBe(true);
  });

  it('is per-key', () => {
    const counter = new FixedWindowCounter({ windowMs: 1000, max: 1 }, () => 0);
    expect(counter.check('ip-1')).toBe(true);
    expect(counter.check('ip-1')).toBe(false);
    expect(counter.check('ip-2')).toBe(true);
  });

  it('bounds its map under many distinct spoofed IPs (idle eviction)', () => {
    let now = 0;
    const counter = new FixedWindowCounter({ windowMs: 1000, max: 3, maxEntries: 10 }, () => now);
    for (let i = 0; i < 1000; i++) {
      now += 200;
      counter.check(`ip-${i}`);
    }
    expect(counter.size).toBeLessThanOrEqual(11);
  });
});
