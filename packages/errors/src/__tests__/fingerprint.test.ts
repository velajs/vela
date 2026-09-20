import { describe, expect, expectTypeOf, it } from 'vitest';
import { bucketMessage, fingerprintError, FINGERPRINT_VERSION, sha256Hex } from '../fingerprint';
import { toErrorBody, VelaError } from '../index';

const HEX16 = /^[0-9a-f]{16}$/;

describe('sha256Hex', () => {
  // Independently-verifiable NIST FIPS 180-4 vectors. These anchor the digest
  // to the real standard, so any drift in the SHA-256 core fails CI.
  it('matches the empty-string vector', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the "abc" vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches a multi-block vector', () => {
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('handles multi-byte UTF-8 input', () => {
    expect(sha256Hex('ünïcödé ★ 你好')).toBe(
      'a46baa2cb982bc356db9ae9b06ff04dc862c7469f951abcb4f34f8fac7311b16',
    );
  });

  it('always returns 64 lowercase hex chars', () => {
    for (const s of ['', 'a', 'hello world', 'x'.repeat(200)]) {
      expect(sha256Hex(s)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('bucketMessage', () => {
  it('folds a UUID, timestamp, and IP to placeholders', () => {
    expect(
      bucketMessage(
        'order 550e8400-e29b-41d4-a716-446655440000 not found at 2026-07-13T10:00:00Z from 192.168.1.44:8080',
      ),
    ).toBe('order [uuid] not found at [time] from [ip]');
  });

  it('collapses a leading-slash request path but keeps in-word slashes', () => {
    expect(bucketMessage('GET /wp-admin/setup.php failed')).toBe('get [path] failed');
    expect(bucketMessage('client/server mismatch')).toBe('client/server mismatch');
  });

  it('folds urls, emails, hex and long ids', () => {
    expect(bucketMessage('fetch https://api.example.com/v2/x?id=7 failed')).toBe(
      'fetch [url] failed',
    );
    expect(bucketMessage('user jane.doe+test@example.co.uk rejected')).toBe(
      'user [email] rejected',
    );
    expect(bucketMessage('pointer 0xDEADBEEF is null')).toBe('pointer [hex] is null');
    expect(bucketMessage('token abcdef0123456789abcdef expired')).toBe('token [id] expired');
  });

  it('replaces bare integers but preserves distinguishing words', () => {
    expect(bucketMessage('retry 12 of 30')).toBe('retry [num] of [num]');
    // Two different failures must NOT collapse just because both are short.
    expect(bucketMessage('model is not supported')).not.toBe(
      bucketMessage('field is not permitted'),
    );
  });

  it('returns empty for an empty message', () => {
    expect(bucketMessage('')).toBe('');
  });

  it('clamps pathological input (ReDoS guard) and bounds the bucket length', () => {
    const started = Date.now();
    const bucket = bucketMessage(`${'a'.repeat(50_000)}@${'b'.repeat(50_000)}`);
    expect(Date.now() - started).toBeLessThan(500);
    expect(bucket.length).toBeLessThanOrEqual(160);
  });
});

describe('fingerprintError', () => {
  it('produces a stable 16-char lowercase hex hash', () => {
    const hash = fingerprintError({ functionPath: 'messages:list', message: 'boom' });
    expect(hash).toMatch(HEX16);
    expect(fingerprintError({ functionPath: 'messages:list', message: 'boom' })).toBe(hash);
  });

  it('GOLDEN: locks the algorithm output (drift fails CI)', () => {
    expect(fingerprintError({ functionPath: 'messages:list', message: 'boom' })).toBe(
      '03de3a7c1ac8ebae',
    );
    expect(
      fingerprintError({ functionPath: 'router:dispatch', message: 'no route for GET /users/42' }),
    ).toBe('ddc4d8dd13461d4e');
    expect(
      fingerprintError({
        functionPath: 'orders:get',
        message: 'order 550e8400-e29b-41d4-a716-446655440000 not found at 2026-07-13T10:00:00Z',
      }),
    ).toBe('2b398d2ab25ccbf2');
  });

  it('collapses the same logical error across differing UUIDs, URLs and ids', () => {
    const a = fingerprintError({
      functionPath: 'orders:get',
      message: 'order 550e8400-e29b-41d4-a716-446655440000 not found at 2026-07-13T10:00:00Z',
    });
    const b = fingerprintError({
      functionPath: 'orders:get',
      message: 'order 3f2504e0-4f89-11d3-9a0c-0305e82c3301 not found at 2020-01-01T00:00:00Z',
    });
    expect(a).toBe(b);
  });

  it('never folds the `code` into the hash', () => {
    const base = fingerprintError({ functionPath: 'messages:list', message: 'boom' });
    const withCode = fingerprintError({
      functionPath: 'messages:list',
      message: 'boom',
      code: 'E_BOOM',
    });
    const otherCode = fingerprintError({
      functionPath: 'messages:list',
      message: 'boom',
      code: 'E_TOTALLY_DIFFERENT',
    });
    expect(withCode).toBe(base);
    expect(otherCode).toBe(base);
  });

  it('splits on a different functionPath', () => {
    const listing = fingerprintError({ functionPath: 'messages:list', message: 'boom' });
    const sending = fingerprintError({ functionPath: 'messages:send', message: 'boom' });
    expect(listing).not.toBe(sending);
  });

  it('folds a route-scanner 404 sweep to a single fingerprint', () => {
    const probes = [
      '404 not found: /wp-admin',
      '404 not found: /.env',
      '404 not found: /.git/config',
      '404 not found: /phpmyadmin/index.php',
      '404 not found: /vendor/phpunit/eval-stdin.php',
    ];
    const hashes = new Set(
      probes.map((message) => fingerprintError({ functionPath: 'http:route', message })),
    );
    expect(hashes.size).toBe(1);
  });

  it('is computable from a toErrorBody echoed wire view and matches the raw error', () => {
    const functionPath = 'router:dispatch';
    const rawMessage = 'no route for GET /users/42';
    const err = new VelaError('not_found', { message: rawMessage });

    const { body, redacted } = toErrorBody(err);
    expect(redacted).toBe(false);

    const fromWire = fingerprintError({
      functionPath,
      message: body.error.message,
      code: body.error.code,
    });
    const fromRaw = fingerprintError({ functionPath, message: rawMessage });
    expect(fromWire).toBe(fromRaw);
  });

  it('is computable from a redacted wire view, independent of the redacted code', () => {
    const err = new VelaError('internal', { message: 'db driver failed host=10.0.0.5' });
    const { body, redacted } = toErrorBody(err);
    expect(redacted).toBe(true);

    const fromWire = fingerprintError({
      functionPath: 'db:connect',
      message: body.error.message,
      code: body.error.code,
    });
    const differentCode = fingerprintError({
      functionPath: 'db:connect',
      message: body.error.message,
      code: 'ANYTHING_ELSE',
    });
    expect(fromWire).toMatch(HEX16);
    expect(fromWire).toBe(differentCode);
  });

  it('exposes a numeric FINGERPRINT_VERSION', () => {
    expect(FINGERPRINT_VERSION).toBe(1);
  });
});

describe('exported type signatures', () => {
  it('fingerprintError dogfoods { functionPath, message, code? } -> string', () => {
    expectTypeOf(fingerprintError).returns.toEqualTypeOf<string>();
    expectTypeOf(fingerprintError)
      .parameter(0)
      .toEqualTypeOf<{ functionPath: string; message: string; code?: string }>();
  });

  it('bucketMessage and sha256Hex are string -> string', () => {
    expectTypeOf(bucketMessage).toEqualTypeOf<(message: string) => string>();
    expectTypeOf(sha256Hex).toEqualTypeOf<(input: string) => string>();
  });

  it('FINGERPRINT_VERSION is a number', () => {
    expectTypeOf(FINGERPRINT_VERSION).toEqualTypeOf<number>();
  });
});
