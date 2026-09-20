import { describe, it, expect } from 'vitest';
import { signUrl, verifySignedUrl, expandPathTemplate, joinStoragePath } from '../storage/index.js';
import { importHmacKey, toBase64Url } from '../crypto/hmac.js';

describe('storage signed URLs', () => {
  const scope = { method: 'GET', purpose: 'test:storage' } as const;

  it('signs and verifies a relative URL', async () => {
    const signed = await signUrl('/storage/uploads/a.png?method=GET', 'secret', {
      expiresIn: 60,
      ...scope,
    });
    expect(signed).toContain('signature=');
    expect(await verifySignedUrl(signed, 'secret', scope)).toBe(true);
  });

  it('rejects a tampered path', async () => {
    const signed = await signUrl('/storage/uploads/a.png', 'secret', {
      expiresIn: 60,
      ...scope,
    });
    expect(await verifySignedUrl(signed.replace('a.png', 'b.png'), 'secret', scope)).toBe(false);
  });

  it('rejects a wrong secret', async () => {
    const signed = await signUrl('/x', 'secret', { expiresIn: 60, ...scope });
    expect(await verifySignedUrl(signed, 'other', scope)).toBe(false);
  });

  it('rejects an empty signing secret', async () => {
    await expect(signUrl('/x', '', { expiresIn: 60, ...scope })).rejects.toThrow(/secret/);
    expect(
      await verifySignedUrl('/x?signature=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '', scope),
    ).toBe(false);
  });

  it('enforces expiry', async () => {
    await expect(signUrl('/x', 'secret', { expiresIn: -1, ...scope })).rejects.toThrow(/positive/);
    await expect(signUrl('/x', 'secret', { expiresIn: 0, ...scope })).rejects.toThrow(/positive/);
    await expect(signUrl('/x', 'secret', { expiresIn: Number.NaN, ...scope })).rejects.toThrow(
      /positive/,
    );
    await expect(
      signUrl('/x', 'secret', { expiresIn: Number.POSITIVE_INFINITY, ...scope }),
    ).rejects.toThrow(/positive/);
    const valid = await signUrl('/x', 'secret', { expiresIn: 60, ...scope });
    expect(await verifySignedUrl(valid, 'secret', scope)).toBe(true);

    // Build a cryptographically valid v2 signature over a URL with no expiry.
    // Verification must reject it because expiry is a mandatory capability claim,
    // not merely because removing an existing expiry broke the signature.
    const key = await importHmacKey('secret');
    const permanentSignature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode('vela-signed-url-v2\ntest:storage\nGET\n/x?'),
    );
    expect(
      await verifySignedUrl(`/x?signature=${toBase64Url(permanentSignature)}`, 'secret', scope),
    ).toBe(false);
  });

  it('returns false for malformed signatures instead of throwing', async () => {
    for (const signature of ['%%%', 'A', '====', '!@#$', 'A'.repeat(10_000)]) {
      await expect(verifySignedUrl(`/x?signature=${signature}`, 'secret', scope)).resolves.toBe(
        false,
      );
    }
  });

  it('binds signatures to HTTP method and purpose', async () => {
    const signed = await signUrl('/x', 'secret', {
      expiresIn: 60,
      method: 'POST',
      purpose: 'test:mutation',
    });
    expect(
      await verifySignedUrl(signed, 'secret', { method: 'POST', purpose: 'test:mutation' }),
    ).toBe(true);
    expect(
      await verifySignedUrl(signed, 'secret', { method: 'GET', purpose: 'test:mutation' }),
    ).toBe(false);
    expect(
      await verifySignedUrl(signed, 'secret', { method: 'POST', purpose: 'test:download' }),
    ).toBe(false);
  });

  it('requires explicit expiry, method, and purpose at the generic utility boundary', async () => {
    await expect(signUrl('/x', 'secret', undefined as never)).rejects.toThrow(/required|positive/);
    const signed = await signUrl('/x', 'secret', { expiresIn: 60, ...scope });
    await expect(verifySignedUrl(signed, 'secret', undefined as never)).resolves.toBe(false);
  });
});

describe('storage path templates', () => {
  const d = new Date(Date.UTC(2026, 6, 1)); // 2026-07-01

  it('expands date tokens deterministically', () => {
    expect(expandPathTemplate('uploads/{year}/{month}/{day}', d)).toBe('uploads/2026/07/01');
    expect(expandPathTemplate('{date}', d)).toBe('2026-07-01');
  });

  it('joins root + relative path, collapsing slashes and stripping the leading slash', () => {
    expect(joinStoragePath('uploads/{year}', 'sub/a.png', d)).toBe('uploads/2026/sub/a.png');
    expect(joinStoragePath('/uploads/', '/a.png', d)).toBe('uploads/a.png');
    expect(joinStoragePath(undefined, 'a.png', d)).toBe('a.png');
  });

  it('neutralizes .. / . segments so keys cannot escape the disk root (path traversal)', () => {
    // `..` is dropped, not applied — the key stays under the root.
    expect(joinStoragePath('uploads', '../private/secret.txt', d)).toBe(
      'uploads/private/secret.txt',
    );
    expect(joinStoragePath('uploads', '../../etc/passwd', d)).toBe('uploads/etc/passwd');
    expect(joinStoragePath('uploads', './a/./b.png', d)).toBe('uploads/a/b.png');
    // `..` segments are dropped (not applied), so the key stays under the root.
    expect(joinStoragePath('media', 'a\\..\\..\\b', d)).toBe('media/a/b');
    expect(joinStoragePath('uploads', '%2e%2e/private/secret.txt', d)).toBe(
      'uploads/private/secret.txt',
    );
    expect(joinStoragePath('uploads', '.%2E/private/secret.txt', d)).toBe(
      'uploads/private/secret.txt',
    );
    expect(joinStoragePath('uploads', '%252e%252e/private/secret.txt', d)).toBe(
      'uploads/private/secret.txt',
    );
  });
});
