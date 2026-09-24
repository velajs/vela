import { describe, expect, expectTypeOf, it } from 'vitest';
import { createAuthz } from '../authz';
import { defineRole } from '../roles';
import { anyOf, allOf, hasPerm, mask } from '../policy';

const authz = createAuthz({ roles: [defineRole('editor', ['posts:write'])] });
const owner = (ctx: { identity: { subject?: string } }, r: { authorId: string }) =>
  ctx.identity.subject === r.authorId;

describe('composition', () => {
  it('anyOf is OR', async () => {
    const p = anyOf(owner, hasPerm(authz, 'posts:write'));
    expect(await p({ identity: { subject: 'u1', roles: [] } }, { authorId: 'u1' })).toBe(true); // owner
    expect(await p({ identity: { subject: 'x', roles: ['editor'] } }, { authorId: 'u1' })).toBe(
      true,
    ); // perm
    expect(await p({ identity: { subject: 'x', roles: [] } }, { authorId: 'u1' })).toBe(false); // neither
  });
  it('allOf is AND', async () => {
    const p = allOf(owner, hasPerm(authz, 'posts:write'));
    expect(await p({ identity: { subject: 'u1', roles: ['editor'] } }, { authorId: 'u1' })).toBe(
      true,
    );
    expect(await p({ identity: { subject: 'u1', roles: [] } }, { authorId: 'u1' })).toBe(false); // missing perm
  });
  it('FAIL-CLOSED: empty anyOf denies', async () => {
    expect(await anyOf()({ identity: {} }, {})).toBe(false);
  });
  it('FAIL-CLOSED: a throwing policy denies its branch (never allows)', async () => {
    const boom = () => {
      throw new Error('policy bug');
    };
    expect(await anyOf(boom)({ identity: {} }, {})).toBe(false);
    expect(await allOf(boom, () => true)({ identity: {} }, {})).toBe(false);
  });
});

describe('mask (fail-closed)', () => {
  it('returns the transform result', () => {
    expect(
      mask((_c: unknown, r: { ssn: string }) => r.ssn.slice(-4))({}, { ssn: '123456789' }),
    ).toBe('6789');
  });
  it('redacts to null when the transform throws', () => {
    expect(
      mask(() => {
        throw new Error('bad');
      })({}, {}),
    ).toBeNull();
  });
});

it('preserves context and resource types through composed policies', () => {
  const policy = anyOf(
    (ctx: { tenant: string }, record: { tenant: string; title: string }) =>
      ctx.tenant === record.tenant,
  );
  expectTypeOf(policy).parameters.toEqualTypeOf<
    [{ tenant: string }, { tenant: string; title: string }]
  >();
  // @ts-expect-error composed policies require the resource fields their inputs require.
  void policy({ tenant: 'a' }, { tenant: 'a' });
});
