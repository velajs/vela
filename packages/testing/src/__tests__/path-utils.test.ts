import { describe, it, expect } from 'vitest';
import { getValueAtPath, hasValueAtPath } from '../http/path-utils.js';

describe('getValueAtPath', () => {
  const obj = {
    data: { user: { id: 7, name: 'Ada', deletedAt: null }, tags: ['a', 'b'] },
    top: 'value',
  };

  it('reads a shallow value', () => {
    expect(getValueAtPath(obj, 'top')).toBe('value');
  });

  it('reads a deep value', () => {
    expect(getValueAtPath(obj, 'data.user.name')).toBe('Ada');
  });

  it('returns the null value at a path', () => {
    expect(getValueAtPath(obj, 'data.user.deletedAt')).toBeNull();
  });

  it('returns undefined when a segment is missing', () => {
    expect(getValueAtPath(obj, 'data.user.email')).toBeUndefined();
  });

  it('returns undefined when traversing through a null/undefined segment', () => {
    expect(getValueAtPath(obj, 'data.user.deletedAt.whatever')).toBeUndefined();
    expect(getValueAtPath(obj, 'missing.deep.path')).toBeUndefined();
  });
});

describe('hasValueAtPath', () => {
  const obj = { a: { b: { c: null } } };

  it('is true for a present key even when its value is null', () => {
    expect(hasValueAtPath(obj, 'a.b.c')).toBe(true);
  });

  it('is false for an absent key', () => {
    expect(hasValueAtPath(obj, 'a.b.d')).toBe(false);
  });

  it('is false when traversing into a primitive', () => {
    expect(hasValueAtPath({ a: 'string' }, 'a.b')).toBe(false);
  });

  it('is false when traversing through null', () => {
    expect(hasValueAtPath(obj, 'a.b.c.d')).toBe(false);
  });
});
