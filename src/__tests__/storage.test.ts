import { describe, it, expect } from 'vitest';
import { signUrl, verifySignedUrl, expandPathTemplate, joinStoragePath } from '../storage/index.js';

describe('storage signed URLs', () => {
  it('signs and verifies a relative URL', async () => {
    const signed = await signUrl('/storage/uploads/a.png?method=GET', 'secret');
    expect(signed).toContain('signature=');
    expect(await verifySignedUrl(signed, 'secret')).toBe(true);
  });

  it('rejects a tampered path', async () => {
    const signed = await signUrl('/storage/uploads/a.png', 'secret');
    expect(await verifySignedUrl(signed.replace('a.png', 'b.png'), 'secret')).toBe(false);
  });

  it('rejects a wrong secret', async () => {
    const signed = await signUrl('/x', 'secret');
    expect(await verifySignedUrl(signed, 'other')).toBe(false);
  });

  it('enforces expiry', async () => {
    const expired = await signUrl('/x', 'secret', { expiresIn: -1 });
    expect(await verifySignedUrl(expired, 'secret')).toBe(false);
    const valid = await signUrl('/x', 'secret', { expiresIn: 60 });
    expect(await verifySignedUrl(valid, 'secret')).toBe(true);
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
  });
});
