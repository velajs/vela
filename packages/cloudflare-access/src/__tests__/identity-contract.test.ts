import { beforeAll, describe, expect, it } from 'vitest';
import { defineIdentity } from '../identity-contract';
import { cloudflareAccessIssuer } from '../issuer';
import { createAccessResolver, IdentityRejectedError } from '../resolver';
import type { StandardResult, StandardSchemaV1 } from '../standard-schema';
import { makeKeyMaterial, mintToken, requestWithHeader, type TestKeyMaterial } from './harness';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * A hand-written Standard Schema v1 validator — proves `defineIdentity` accepts
 * any spec-compliant schema with no runtime dependency on zod/valibot/arktype.
 */
const schema = <Output>(
  validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>,
): StandardSchemaV1<unknown, Output> => ({
  '~standard': { version: 1, vendor: 'test-fixture', validate },
});

/** Requires `userId` and `tenantId` string claims; extra claims are ignored (pass through). */
const tenantSchema = schema<{ userId: string; tenantId: string }>((value) => {
  if (isRecord(value) && typeof value.userId === 'string' && typeof value.tenantId === 'string') {
    return { value: { userId: value.userId, tenantId: value.tenantId } };
  }
  return {
    issues: [{ message: 'userId and tenantId are required strings', path: ['tenantId'] }],
  };
});

describe('defineIdentity', () => {
  it('brands the contract and defaults subjectClaim/onInvalid', () => {
    const contract = defineIdentity({ claims: tenantSchema });
    expect(contract.__velaIdentity).toBe(true);
    expect(contract.subjectClaim).toBe('userId');
    expect(contract.onInvalid).toBe('anonymous');
  });

  it('validates a conforming claim set (ok:true), forwarding undeclared claims implicitly', async () => {
    const contract = defineIdentity({ claims: tenantSchema });
    // `role` is undeclared — the schema neither rejects nor strips it; the
    // resolver forwards the raw claim set, so undeclared claims pass through.
    const result = await contract.validate({ userId: 'u-1', tenantId: 't-1', role: 'admin' });
    expect(result).toEqual({ ok: true });
  });

  it('fails closed (ok:false) with a message that never echoes claim values', async () => {
    const contract = defineIdentity({ claims: tenantSchema });
    const result = await contract.validate({ userId: 'u-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('tenantId');
      expect(result.error).not.toContain('u-1');
    }
  });

  it('re-checks the required string subject even when a lax schema casts past the type', async () => {
    // A schema that always "passes" regardless of input — the runtime subject
    // guard must still reject a missing/empty subject fail-closed.
    const laxSchema = schema<{ userId: string }>(() => ({ value: { userId: 'ignored' } }));
    const contract = defineIdentity({ claims: laxSchema });

    expect(await contract.validate({ userId: 'present' })).toEqual({ ok: true });

    const missing = await contract.validate({ notUserId: 'x' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('userId');

    const empty = await contract.validate({ userId: '' });
    expect(empty.ok).toBe(false);
  });

  it('honors a custom subjectClaim', async () => {
    const subjectSchema = schema<{ userId: string }>((value) =>
      isRecord(value) && typeof value.sub === 'string'
        ? { value: { userId: value.sub } }
        : { issues: [{ message: 'sub required' }] },
    );
    const contract = defineIdentity({ claims: subjectSchema, subjectClaim: 'sub' });
    expect(contract.subjectClaim).toBe('sub');
    expect(await contract.validate({ sub: 'user-9' })).toEqual({ ok: true });
    const bad = await contract.validate({ sub: '' });
    expect(bad.ok).toBe(false);
  });

  it('awaits an async Standard Schema validator', async () => {
    const asyncSchema = schema<{ userId: string }>(async (value) =>
      isRecord(value) && typeof value.userId === 'string'
        ? { value: { userId: value.userId } }
        : { issues: [{ message: 'userId required' }] },
    );
    const contract = defineIdentity({ claims: asyncSchema });
    const pending = contract.validate({ userId: 'u-1' });
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual({ ok: true });
  });
});

describe('createAccessResolver + identity contract', () => {
  const preset = cloudflareAccessIssuer('acme');
  const AUD = 'app-audience-tag';
  let keys: TestKeyMaterial;

  beforeAll(async () => {
    keys = await makeKeyMaterial();
  });

  const tokenWith = (claims: Record<string, unknown>, subject = 'user-42'): Promise<string> =>
    mintToken({
      privateKey: keys.privateKey,
      kid: keys.kid,
      issuer: preset.issuer,
      audience: AUD,
      subject,
      claims,
    });

  it('mints an identity when the verified claims satisfy the contract', async () => {
    const resolve = createAccessResolver({
      preset,
      aud: AUD,
      keySet: keys.jwks,
      identity: defineIdentity({ claims: tenantSchema }),
    });
    const token = await tokenWith({ userId: 'user-42', tenantId: 't-1', role: 'admin' });
    const identity = await resolve(requestWithHeader(preset.header, token));

    expect(identity).not.toBeNull();
    expect(identity?.userId).toBe('user-42');
    // Undeclared `role` survives on the forwarded claim set.
    expect(identity?.claims.role).toBe('admin');
  });

  it('downgrades a contract violation to anonymous (null) under onInvalid:"anonymous"', async () => {
    const resolve = createAccessResolver({
      preset,
      aud: AUD,
      keySet: keys.jwks,
      identity: defineIdentity({ claims: tenantSchema, onInvalid: 'anonymous' }),
    });
    const token = await tokenWith({ userId: 'user-42' }); // no tenantId
    expect(await resolve(requestWithHeader(preset.header, token))).toBeNull();
  });

  it('throws a 401-shaped IdentityRejectedError under onInvalid:"reject"', async () => {
    const resolve = createAccessResolver({
      preset,
      aud: AUD,
      keySet: keys.jwks,
      identity: defineIdentity({ claims: tenantSchema, onInvalid: 'reject' }),
    });
    const token = await tokenWith({ userId: 'user-42' }); // no tenantId
    await expect(resolve(requestWithHeader(preset.header, token))).rejects.toBeInstanceOf(
      IdentityRejectedError,
    );
    try {
      await resolve(requestWithHeader(preset.header, token));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IdentityRejectedError);
      if (error instanceof IdentityRejectedError) expect(error.status).toBe(401);
    }
  });
});
