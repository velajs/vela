import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  STUDIO_OPS,
  STUDIO_RESPONSE_PARSERS,
  parseStudioResponse,
  parseStudioRpcResponse,
} from '../src';
import type { RouteRow, StudioCapabilities, StudioRowPage } from '../src';

describe('operation-associated responses', () => {
  it('has a validator for every catalog operation', () => {
    expect(Object.keys(STUDIO_RESPONSE_PARSERS).toSorted()).toEqual(STUDIO_OPS.toSorted());
    expectTypeOf(parseStudioResponse('app.routes', [])).toEqualTypeOf<RouteRow[]>();
    expectTypeOf(
      parseStudioResponse<'studio.capabilities'>,
    ).returns.toEqualTypeOf<StudioCapabilities>();
    expectTypeOf(parseStudioResponse<'data.listRows'>).returns.toEqualTypeOf<StudioRowPage>();
    expectTypeOf(parseStudioResponse('app.openapi', {})).toEqualTypeOf<unknown>();
    // @ts-expect-error A caller cannot select an arbitrary response type.
    parseStudioResponse<{ fabricated: true }>('app.routes', []);
  });

  it.each(STUDIO_OPS.filter((op) => op !== 'app.openapi'))(
    'rejects an invalid %s payload',
    (op) => {
      expect(() => parseStudioResponse(op, 'not an operation result')).toThrow();
    },
  );

  it('rejects malformed nested fields and data for a different operation', () => {
    expect(() =>
      parseStudioResponse('auth.users', {
        rows: [{ id: 'u', email: 'a@b.test', emailVerified: 'yes', createdAt: 1 }],
      }),
    ).toThrow();
    expect(() =>
      parseStudioResponse('data.listRows', {
        rows: [{ id: 'u' }],
        info: { page: 1, per_page: 20, has_next_page: 'false', has_prev_page: false },
      }),
    ).toThrow();
    expect(() => parseStudioResponse('app.routes', [{ moduleId: 'App', imports: [] }])).toThrow();
    expect(() => parseStudioResponse('studio.capabilities', {})).toThrow();
    expect(() =>
      parseStudioResponse('flags.evaluate', { flagKey: 'f', value: null, reason: 'STATIC' }),
    ).toThrow();
  });

  it('preserves dynamic records without assigning a narrower row or document type', () => {
    const value = { id: 'u', nested: { flags: [true, false] }, nullable: null };
    expect(parseStudioResponse('data.readRow', value)).toEqual(value);
    expect(parseStudioResponse('data.readRow', null)).toBeNull();
    expect(parseStudioResponse('app.openapi', value)).toEqual(value);
  });
});

describe('RPC envelopes', () => {
  const success = {
    ok: true,
    op: 'app.routes',
    data: [],
    meta: { ms: 1, op: 'app.routes', mode: 'read' },
  };
  const failure = {
    ok: false,
    op: 'app.routes',
    status: 403,
    error: {
      code: 'STUDIO_OP_FORBIDDEN',
      title: 'Forbidden',
      status: 403,
      message: 'Read only',
      hint: 'Enable editing',
      details: { confirmToken: 'token' },
    },
  };

  it('accepts checked success and error envelopes', () => {
    expect(parseStudioRpcResponse('app.routes', success)).toEqual(success);
    expect(parseStudioRpcResponse('app.routes', failure)).toEqual(failure);
  });

  it.each([
    { ...success, ok: 'true' },
    { ...success, op: 'app.modules' },
    { ...success, meta: { ...success.meta, op: 'app.modules' } },
    { ...success, meta: { ...success.meta, mode: 'write' } },
    { ...success, data: [{}] },
    { ...failure, error: { ...failure.error, hint: 5 } },
    { ...failure, status: 401 },
    { ...failure, error: null },
  ])('rejects an invalid envelope %#', (value) => {
    expect(() => parseStudioRpcResponse('app.routes', value)).toThrow();
  });
});

describe('feature flag provider metadata', () => {
  it('preserves open provider reasons, variants and error codes', () => {
    const details = {
      flagKey: 'layout',
      value: 'safe',
      reason: 'PROVIDER_DEFAULT',
      variant: 'control',
      errorCode: 'FLAG_NOT_FOUND',
    };
    expect(parseStudioResponse('flags.evaluate', details)).toEqual(details);
  });
  it.each([{ reason: 4 }, { variant: false }, { errorCode: {} }])(
    'rejects invalid metadata %j',
    (metadata) => {
      expect(() =>
        parseStudioResponse('flags.evaluate', {
          flagKey: 'flag',
          value: false,
          reason: 'UNKNOWN',
          ...metadata,
        }),
      ).toThrow();
    },
  );
});
