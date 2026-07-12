import { describe, expect, it } from 'vitest';
import { anonymous } from '../identity';
import { defineRole, definePermission } from '../roles';

describe('role builders', () => {
  it('defineRole captures name + permissions', () => {
    const r = defineRole('editor', ['posts:read', 'posts:write']);
    expect(r).toEqual({ name: 'editor', permissions: ['posts:read', 'posts:write'] });
  });
  it('definePermission captures the name', () => {
    expect(definePermission('posts:write')).toEqual({ name: 'posts:write' });
  });
  it('defineRole copies its permissions input (no shared reference)', () => {
    const input = ['a'];
    const r = defineRole('x', input);
    expect(r.permissions).not.toBe(input);
  });
  it('anonymous has no roles', () => {
    expect(anonymous.roles).toEqual([]);
  });
  it('anonymous is frozen (shared fail-closed default cannot be mutated)', () => {
    expect(Object.isFrozen(anonymous)).toBe(true);
    expect(Object.isFrozen(anonymous.roles)).toBe(true);
  });
});
