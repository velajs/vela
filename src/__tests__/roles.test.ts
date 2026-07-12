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
  it('anonymous has no roles', () => {
    expect(anonymous.roles).toEqual([]);
  });
});
