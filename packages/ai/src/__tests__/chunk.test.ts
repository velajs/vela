import { describe, expect, it } from 'vitest';
import { fixedWindowChunks } from '../rag';

describe('fixedWindowChunks', () => {
  it('returns no windows for empty or whitespace-only text', () => {
    expect(fixedWindowChunks('', 10, 0)).toEqual([]);
    expect(fixedWindowChunks('   \n\t ', 10, 0)).toEqual([]);
  });

  it('returns a single trimmed window when text fits', () => {
    expect(fixedWindowChunks('  hello  ', 10, 0)).toEqual(['hello']);
  });

  it('splits into overlapping windows', () => {
    const chunks = fixedWindowChunks('abcdefghij', 4, 2);
    // stride = size - overlap = 2
    expect(chunks).toEqual(['abcd', 'cdef', 'efgh', 'ghij']);
  });

  it('splits without overlap when overlap is 0', () => {
    expect(fixedWindowChunks('abcdefgh', 4, 0)).toEqual(['abcd', 'efgh']);
  });

  it('covers every character of the input', () => {
    const text = 'the quick brown fox jumps over';
    const joined = fixedWindowChunks(text, 7, 0).join('');
    expect(joined).toBe(text);
  });

  it('rejects invalid size/overlap', () => {
    expect(() => fixedWindowChunks('abc', 0, 0)).toThrow(/positive integer/);
    expect(() => fixedWindowChunks('abc', 4, 4)).toThrow(/smaller than/);
    expect(() => fixedWindowChunks('abc', 4, -1)).toThrow(/non-negative/);
  });
});
