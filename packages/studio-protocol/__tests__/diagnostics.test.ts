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

  it('labels the default lifetime "default" and rejects the retired "singleton" label', () => {
    const node = (scope: string) => ({
      moduleId: 'a',
      imports: [],
      exports: [],
      providers: ['A'],
      isGlobal: false,
      lazy: false,
      providerScopes: [{ token: 'A', scope }],
    });
    expect(parseStudioResponse('app.modules', [node('default')])).toEqual([node('default')]);
    expect(
      parseStudioResponse('app.entrypoints', [
        { kind: 'cron', target: 'Jobs#run', scope: 'default' },
      ]),
    ).toEqual([{ kind: 'cron', target: 'Jobs#run', scope: 'default' }]);
    expect(() => parseStudioResponse('app.modules', [node('singleton')])).toThrow();
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

it('preserves optional database namespaces and rejects malformed namespaces', () => {
  const model = {
    name: 'alpha::user',
    table: 'users',
    database: 'alpha',
    label: 'users',
    capabilities: [],
  };
  expect(parseStudioResponse('data.listModels', [model])).toEqual([model]);
  expect(() => parseStudioResponse('data.listModels', [{ ...model, database: 4 }])).toThrow();
});
