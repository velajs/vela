import { describe, expect, it } from 'vitest';
import { contentHash } from '../rag';

describe('contentHash (FNV-1a 64-bit, change-detection only)', () => {
  it('matches the canonical FNV-1a-64 golden values (guards against algorithm drift)', () => {
    // Independently verifiable reference vectors for FNV-1a 64-bit:
    expect(contentHash('')).toBe('cbf29ce484222325'); // the offset basis
    expect(contentHash('a')).toBe('af63dc4c8601ec8c');
    expect(contentHash('hello')).toBe('a430d84680aabd0b');
  });

  it('always returns 16 lowercase hex characters', () => {
    for (const input of ['', 'x', 'a longer document body with unicode ✓ é 漢字']) {
      expect(contentHash(input)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('is stable across repeated calls on the same input', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    expect(contentHash(text)).toBe(contentHash(text));
  });

  it('changes when the text changes (detects edits)', () => {
    expect(contentHash('version one')).not.toBe(contentHash('version two'));
    expect(contentHash('trailing space ')).not.toBe(contentHash('trailing space'));
  });
});
