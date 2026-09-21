import { describe, expect, it } from 'vitest';
import { assertJson, parseRpcRequest, parseRpcResponse } from '../protocol';

const request = { version: 1, id: 'call-1', procedure: 'users.get', input: { id: 'u1' } };
describe('RPC v1 envelopes', () => {
  it('retains null, false, zero and empty strings', () => {
    for (const value of [null, false, 0, '']) {
      expect(parseRpcRequest({ ...request, input: value }).input).toBe(value);
      expect(
        parseRpcResponse(
          { version: 1, id: request.id, procedure: request.procedure, ok: true, result: value },
          request,
        ),
      ).toMatchObject({ result: value });
    }
  });
  it.each([
    { version: 2 },
    { id: '' },
    { id: '\n' },
    { id: 'x'.repeat(129) },
    { procedure: 'plain' },
    { procedure: 'users..get' },
    { input: undefined },
    { extra: 'ignored?' },
  ])('rejects malformed request fields %j', (fields) => {
    expect(() => parseRpcRequest({ ...request, ...fields })).toThrow();
  });
  it('requires correlation and a complete bounded error', () => {
    const failure = {
      version: 1,
      id: request.id,
      procedure: request.procedure,
      ok: false,
      error: { code: 'forbidden', message: 'Denied', status: 403 },
    };
    expect(parseRpcResponse(failure, request)).toEqual(failure);
    for (const bad of [
      { ...failure, id: 'wrong' },
      { ...failure, procedure: 'users.delete' },
      { ...failure, error: null },
      { ...failure, error: { ...failure.error, status: 200 } },
      { ...failure, error: { ...failure.error, message: 'x'.repeat(2049) } },
      { ...failure, error: { ...failure.error, details: {} } },
    ])
      expect(() => parseRpcResponse(bad, request)).toThrow();
  });
  it('rejects lossy or executable JSON values without invoking getters', () => {
    let accessed = false;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const accessor = {
      get secret() {
        accessed = true;
        return 'no';
      },
    };
    const symbolArray = [1];
    Object.defineProperty(symbolArray, Symbol('hidden'), { value: 'x' });
    for (const bad of [
      undefined,
      NaN,
      Infinity,
      1n,
      new Date(),
      new Map(),
      cycle,
      [undefined],
      Array(2),
      accessor,
      symbolArray,
    ])
      expect(() => assertJson(bad)).toThrow();
    expect(accessed).toBe(false);
    const shared = { one: 1 };
    expect(() => assertJson([shared, shared])).not.toThrow();
  });
});
