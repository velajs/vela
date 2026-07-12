import { describe, expect, it } from 'vitest';
import { anonymous } from '../identity';
import { defineRole, definePermission } from '../roles';
import { can } from '../can';
import { createAuthz } from '../authz';

const editor = defineRole('editor', ['posts:read', 'posts:write']);
const admin = defineRole('admin', ['*']);
const mod = defineRole('mod', ['posts:*']);

describe('createAuthz + can (role-backed default resolver)', () => {
  const authz = createAuthz({ roles: [editor, admin, mod] });

  it('grants an exact permission the role holds', async () => {
    expect(await authz.can({ roles: ['editor'] }, 'posts:write')).toBe(true);
    expect(await authz.can({ roles: ['editor'] }, 'posts:delete')).toBe(false);
  });
  it('* grants everything', async () => {
    expect(await authz.can({ roles: ['admin'] }, 'anything:at:all')).toBe(true);
  });
  it('resource:* grants any action under the resource', async () => {
    expect(await authz.can({ roles: ['mod'] }, 'posts:delete')).toBe(true);
    expect(await authz.can({ roles: ['mod'] }, 'users:delete')).toBe(false);
  });
  it('FAIL-CLOSED: unknown role grants nothing', async () => {
    expect(await authz.can({ roles: ['ghost'] }, 'posts:read')).toBe(false);
  });
  it('FAIL-CLOSED: anonymous / no roles grants nothing', async () => {
    expect(await authz.can(anonymous, 'posts:read')).toBe(false);
    expect(await authz.can({}, 'posts:read')).toBe(false);
  });
  it('FAIL-CLOSED: a throwing resolver denies (never allows on error)', async () => {
    const boom = { grants() { throw new Error('resolver down'); } };
    expect(await can({ roles: ['admin'] }, 'posts:read', boom)).toBe(false);
  });
  it('createAuthz flags a role granting an undeclared permission when permissions are declared', () => {
    expect(() =>
      createAuthz({ roles: [defineRole('x', ['posts:frobnicate'])], permissions: [definePermission('posts:read')] }),
    ).toThrow(/undeclared permission 'posts:frobnicate'/);
  });
});
