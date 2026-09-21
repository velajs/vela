import { describe, expect, it } from 'vitest';
import { parseStudioResponse, parseStudioRpcResponse } from '../src';

const invocation = {
  kind: 'queue',
  source: 'Email#send',
  moduleId: 'emails',
  invocationId: 'inv-1',
  elapsedMs: 1.25,
  outcome: 'returned',
  boundary: 'handler',
};

describe('additive diagnostic wire fields', () => {
  it('keeps older v2 logs and module descriptions valid', () => {
    expect(parseStudioResponse('logs.tail', [{ ts: 1, level: 'info', msg: 'ok' }])).toEqual([
      { ts: 1, level: 'info', msg: 'ok' },
    ]);
    const node = {
      moduleId: 'a',
      imports: [],
      exports: [],
      providers: [],
      isGlobal: false,
      lazy: false,
    };
    expect(parseStudioResponse('app.modules', [node])).toEqual([node]);
  });

  it('round-trips timing and module-qualified scopes through the same operation validators', () => {
    const data = [{ ts: 1, level: 'info', msg: 'handler returned', invocation }];
    expect(
      parseStudioRpcResponse('logs.tail', {
        ok: true,
        op: 'logs.tail',
        data,
        meta: { op: 'logs.tail', ms: 1, mode: 'read' },
      }),
    ).toMatchObject({ ok: true, data });
    expect(
      parseStudioResponse('app.entrypoints', [
        { kind: 'queue', target: 'Email#send', moduleId: 'emails', scope: 'request' },
      ])[0],
    ).toMatchObject({ moduleId: 'emails', scope: 'request' });
  });

  it.each([
    { elapsedMs: -1 },
    { elapsedMs: Infinity },
    { elapsedMs: '1' },
    { boundary: 'all-background-work' },
    { outcome: '200' },
    { invocationId: 42 },
  ])('rejects malformed invocation detail %j', (invalid) => {
    expect(() =>
      parseStudioResponse('logs.tail', [
        { ts: 1, level: 'info', msg: 'ok', invocation: { ...invocation, ...invalid } },
      ]),
    ).toThrow();
  });

  it('rejects fabricated scope names', () => {
    expect(() =>
      parseStudioResponse('app.modules', [
        {
          moduleId: 'a',
          imports: [],
          exports: [],
          providers: [],
          isGlobal: false,
          lazy: true,
          providerScopes: [{ token: 'A', scope: 'global' }],
        },
      ]),
    ).toThrow();
  });
});
