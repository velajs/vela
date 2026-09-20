import { describe, expectTypeOf, it } from 'vitest';
import {
  cloudflareAccessIssuer,
  composeResolvers,
  createAccessResolver,
  defineIdentity,
  genericOidcIssuer,
  verifyAccessJwt,
} from '..';
import type {
  AccessClaims,
  InferIdentity,
  IssuerPreset,
  ResolveIdentity,
  ResolvedIdentity,
} from '..';
import type { StandardSchemaV1 } from '../standard-schema';
import { identityFromAccess } from '../vela';
import type { Identity } from '@velajs/authz';

/**
 * Type-level dogfooding of the exported signatures. No `as any` / `as never`:
 * every assertion drives the real public types. This file is compiled by
 * `tsc --noEmit -p tsconfig.test.json`, so a signature regression fails the build.
 */
describe('exported type signatures', () => {
  it('verifyAccessJwt resolves the verified AccessClaims', () => {
    expectTypeOf(verifyAccessJwt).returns.toEqualTypeOf<Promise<AccessClaims>>();
  });

  it('createAccessResolver / composeResolvers return the structural ResolveIdentity', () => {
    expectTypeOf(createAccessResolver).returns.toEqualTypeOf<ResolveIdentity>();
    expectTypeOf(composeResolvers).returns.toEqualTypeOf<ResolveIdentity>();
  });

  it('the issuer presets return an IssuerPreset', () => {
    expectTypeOf(cloudflareAccessIssuer).returns.toEqualTypeOf<IssuerPreset>();
    expectTypeOf(genericOidcIssuer).returns.toEqualTypeOf<IssuerPreset>();
  });

  it('identityFromAccess bridges to @velajs/authz Identity', () => {
    expectTypeOf(identityFromAccess).returns.toEqualTypeOf<Identity>();
    expectTypeOf(identityFromAccess).parameter(0).toEqualTypeOf<ResolvedIdentity>();
  });

  it('a resolver is structurally assignable to a framework identity hook without importing vela', () => {
    type FrameworkIdentityHook = (
      request: Request,
      env?: unknown,
    ) => Promise<ResolvedIdentity | null> | ResolvedIdentity | null;

    const resolver = createAccessResolver({ preset: cloudflareAccessIssuer('acme'), aud: 'a' });
    // Compile-time assignability check — no cast.
    const hook: FrameworkIdentityHook = resolver;
    expectTypeOf(hook).toEqualTypeOf<FrameworkIdentityHook>();
  });

  it('ResolvedIdentity exposes a required canonical millisecond expiry', () => {
    expectTypeOf<ResolvedIdentity['expiresAtMs']>().toEqualTypeOf<number>();
    expectTypeOf<ResolvedIdentity['userId']>().toEqualTypeOf<string>();
    expectTypeOf<ResolvedIdentity['issuer']>().toEqualTypeOf<string>();
    expectTypeOf<ResolvedIdentity['subject']>().toEqualTypeOf<string>();
  });

  it('defineIdentity infers the declared claim type via InferIdentity', () => {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null;
    const schema: StandardSchemaV1<unknown, { userId: string; tenantId: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test-fixture',
        validate: (value) =>
          isRecord(value) && typeof value.userId === 'string' && typeof value.tenantId === 'string'
            ? { value: { userId: value.userId, tenantId: value.tenantId } }
            : { issues: [{ message: 'invalid claims' }] },
      },
    };
    const contract = defineIdentity({ claims: schema });
    expectTypeOf<InferIdentity<typeof contract>>().toEqualTypeOf<{
      userId: string;
      tenantId: string;
    }>();
  });
});
