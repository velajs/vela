import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ENV, InjectionToken, Module, defineProvider } from '@velajs/vela';
import { SchemaValidationError, type StandardSchemaV1 } from '@velajs/vela/validation';
import { createCloudflareApp } from '../cloudflare-factory';
import { createPipelinesWriter, type PipelinesBinding, type PipelinesWriter } from '../pipelines';

const schema = z.object({ id: z.string(), count: z.string().transform(Number) });
const jsonSchema: StandardSchemaV1<unknown, Record<string, unknown>> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return { value: value as Record<string, unknown> };
      }
      return { issues: [{ message: 'Expected object' }] };
    },
  },
};

function setup<S extends StandardSchemaV1<unknown, Record<string, unknown>>>(validator: S) {
  const send = vi.fn<(records: Record<string, unknown>[]) => Promise<void>>().mockResolvedValue();
  return { send, writer: createPipelinesWriter({ send }, { schema: validator }) };
}

describe('Pipelines producer validation', () => {
  it('sends schema outputs in order, once, with the native receiver', async () => {
    const calls: { id: string; count: number }[][] = [];
    const binding = {
      async send(records: { id: string; count: number }[]) {
        expect(this).toBe(binding);
        calls.push(records);
      },
    };
    const writer = createPipelinesWriter(binding, { schema });
    await expect(
      writer.send([
        { id: 'one', count: '2' },
        { id: 'two', count: '3' },
      ]),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      [
        { id: 'one', count: 2 },
        { id: 'two', count: 3 },
      ],
    ]);
    // Wrapping does not replace or consume the handle.
    await binding.send([{ id: 'native', count: 4 }]);
    expect(calls).toHaveLength(2);
  });

  it('awaits async transforms exactly once per record', async () => {
    const transformed = vi.fn(async (id: string) => ({ id: id.toUpperCase() }));
    const { writer, send } = setup(z.string().transform(transformed));
    await writer.send(['first', 'second']);
    expect(transformed.mock.calls).toEqual([
      ['first', expect.anything()],
      ['second', expect.anything()],
    ]);
    expect(send).toHaveBeenCalledExactlyOnceWith([{ id: 'FIRST' }, { id: 'SECOND' }]);
  });

  it('validates every record before sending and prefixes schema issue paths with its index', async () => {
    const { writer, send } = setup(z.object({ payload: z.object({ id: z.string().min(1) }) }));
    await expect(
      writer.send([{ payload: { id: 'valid' } }, { payload: { id: '' } }]),
    ).rejects.toMatchObject({
      name: 'SchemaValidationError',
      issues: [expect.objectContaining({ path: [1, 'payload', 'id'] })],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('waits for the entire asynchronous batch before calling the binding', async () => {
    const pending = Promise.withResolvers<StandardSchemaV1.Result<{ id: string }>>();
    const entered = Promise.withResolvers<void>();
    const { writer, send } = setup({
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate(value: unknown) {
          if (value === 'first') return { value: { id: 'first' } };
          entered.resolve();
          return pending.promise;
        },
      },
    });
    const result = writer.send(['first', 'second']);
    await entered.promise;
    expect(send).not.toHaveBeenCalled();
    pending.resolve({ issues: [{ message: 'Invalid second record' }] });
    await expect(result).rejects.toBeInstanceOf(SchemaValidationError);
    expect(send).not.toHaveBeenCalled();
  });

  it('awaits native acceptance and propagates rejection without retry', async () => {
    const accepted = Promise.withResolvers<void>();
    const called = Promise.withResolvers<void>();
    const send = vi.fn(() => {
      called.resolve();
      return accepted.promise;
    });
    const writer = createPipelinesWriter({ send }, { schema });
    let settled = false;
    const result = writer.send([{ id: 'one', count: '1' }]).finally(() => {
      settled = true;
    });
    await called.promise;
    expect(settled).toBe(false);
    const failure = new Error('native send failed');
    accepted.reject(failure);
    await expect(result).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('preserves exceptions from schema code without sending', async () => {
    const failure = new Error('validator failed');
    const { writer, send } = setup(
      z.string().transform((): { id: string } => {
        throw failure;
      }),
    );
    await expect(writer.send(['first'])).rejects.toBe(failure);
    expect(send).not.toHaveBeenCalled();
  });

  it('snapshots outputs before later asynchronous validations mutate them', async () => {
    const shared = { nested: { id: 'first' } };
    const { writer, send } = setup(
      z.string().transform(async (id) => {
        shared.nested.id = id;
        return shared;
      }),
    );
    await writer.send(['first', 'second']);
    expect(send).toHaveBeenCalledExactlyOnceWith([
      { nested: { id: 'first' } },
      { nested: { id: 'second' } },
    ]);
    shared.nested.id = 'later';
    expect(send.mock.calls[0]?.[0][0]).toEqual({ nested: { id: 'first' } });
  });

  it('captures batch membership before asynchronous validation', async () => {
    const ready = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    const records = [{ id: 'first' }, { id: 'second' }];
    const { writer, send } = setup(
      z.object({ id: z.string() }).transform(async (record) => {
        if (record.id === 'first') {
          ready.resolve();
          await pending.promise;
        }
        return record;
      }),
    );
    const result = writer.send(records);
    await ready.promise;
    records.splice(1, 1, { id: 'replacement' });
    pending.resolve();
    await result;
    expect(send).toHaveBeenCalledExactlyOnceWith([{ id: 'first' }, { id: 'second' }]);
  });

  it('keeps writers bound to the ENV of each application', async () => {
    const events = new InjectionToken<PipelinesWriter<unknown>>('stream writer');
    @Module({
      providers: [
        defineProvider(events, {
          inject: [ENV],
          useFactory: (env) =>
            createPipelinesWriter(Reflect.get(env, 'STREAM') as PipelinesBinding, {
              schema: jsonSchema,
            }),
        }),
      ],
    })
    class App {}
    const streamA = { send: vi.fn().mockResolvedValue(undefined) };
    const streamB = { send: vi.fn().mockResolvedValue(undefined) };
    const [a, b] = await Promise.all([
      createCloudflareApp(App, { env: { STREAM: streamA } }),
      createCloudflareApp(App, { env: { STREAM: streamB } }),
    ]);
    try {
      expect(a.get(events)).not.toBe(b.get(events));
      await Promise.all([
        a.get(events).send([{ source: 'a' }]),
        b.get(events).send([{ source: 'b' }]),
      ]);
      expect(streamA.send).toHaveBeenCalledExactlyOnceWith([{ source: 'a' }]);
      expect(streamB.send).toHaveBeenCalledExactlyOnceWith([{ source: 'b' }]);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});

describe('Pipelines strict JSON boundary', () => {
  it.each([
    ['undefined', undefined],
    ['function', () => 1],
    ['symbol', Symbol('value')],
    ['bigint', 1n],
    ['NaN', NaN],
    ['infinity', Infinity],
    ['negative infinity', -Infinity],
    ['date', new Date()],
    ['map', new Map()],
    ['set', new Set()],
    ['typed array', new Uint8Array([1])],
    [
      'class instance',
      new (class RecordValue {
        value = 1;
      })(),
    ],
    ['sparse array', new Array(2)],
    ['toJSON', { toJSON: () => 'hidden' }],
    ['symbol property', { [Symbol('key')]: 'hidden' }],
    ['nonenumerable property', Object.defineProperty({}, 'hidden', { value: 1 })],
    ['extra array property', Object.assign([1], { extra: 2 })],
  ])('rejects nested %s before sending any record', async (_name, value) => {
    const { writer, send } = setup(jsonSchema);
    await expect(writer.send([{ valid: true }, { nested: [{ value }] }])).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects circular references but permits shared noncircular objects', async () => {
    const { writer, send } = setup(jsonSchema);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(writer.send([circular])).rejects.toThrow('circular');
    expect(send).not.toHaveBeenCalled();
    const child = { id: 'shared' };
    await writer.send([{ a: child, b: child }]);
    expect(send).toHaveBeenCalledExactlyOnceWith([{ a: child, b: child }]);
  });

  it('rejects getters and toJSON hooks without executing them', async () => {
    const getter = vi.fn(() => 'changed');
    const toJSON = vi.fn(() => ({}));
    const { writer, send } = setup(jsonSchema);
    await expect(
      writer.send([
        { nested: Object.defineProperty({}, 'value', { get: getter, enumerable: true }) },
      ]),
    ).rejects.toThrow('data properties');
    await expect(writer.send([{ nested: { toJSON } }])).rejects.toThrow('not representable');
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves JSON keys, null prototypes and nested values', async () => {
    const { writer, send } = setup(jsonSchema);
    const input: unknown = JSON.parse(
      '{"__proto__":{"safe":true},"toJSON":"data","nested":[null,true,42,"é",{}]}',
    );
    await writer.send([input, Object.create(null)]);
    expect(JSON.stringify(send.mock.calls[0]?.[0])).toBe(`[${JSON.stringify(input)},{}]`);
    expect(Object.hasOwn(send.mock.calls[0]?.[0][0] ?? {}, '__proto__')).toBe(true);
  });

  it.each([[], new Array(1), 'not an array', null])('rejects invalid batch %j', async (records) => {
    const { writer, send } = setup(jsonSchema);
    await expect(writer.send(records as readonly unknown[])).rejects.toBeInstanceOf(TypeError);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([null, [], 'value', 1])('checks invalid schema output %j at runtime', async (output) => {
    const malformed = {
      '~standard': { version: 1, vendor: 'test', validate: () => ({ value: output }) },
    } as unknown as StandardSchemaV1<unknown, Record<string, unknown>>;
    const { writer, send } = setup(malformed);
    await expect(writer.send([{}])).rejects.toThrow('JSON object');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('Pipelines UTF-8 ingestion limits', () => {
  const limit = 5_000_000;
  const recordBytes = new TextEncoder().encode(JSON.stringify({ value: '' })).byteLength;

  it('accepts one record at the exact framed limit and rejects one byte over', async () => {
    const { writer, send } = setup(jsonSchema);
    const value = 'a'.repeat(limit - recordBytes - 2);
    await writer.send([{ value }]);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockClear();
    await expect(writer.send([{ value: value + 'a' }])).rejects.toThrow('record 0 exceeds');
    expect(send).not.toHaveBeenCalled();
  });

  it('counts commas and brackets for a multi-record batch without splitting it', async () => {
    const { writer, send } = setup(jsonSchema);
    const first = { value: 'a'.repeat(2_500_000 - recordBytes) };
    const second = { value: 'b'.repeat(2_500_000 - recordBytes - 3) };
    await writer.send([first, second]);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockClear();
    await expect(writer.send([first, { value: second.value + 'b' }])).rejects.toThrow(
      'batch exceeds',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('measures transformed UTF-8 bytes including escapes, not input character counts', async () => {
    const { writer, send } = setup(z.number().transform((count) => ({ value: 'é'.repeat(count) })));
    await expect(writer.send([2_500_000])).rejects.toBeInstanceOf(RangeError);
    expect(send).not.toHaveBeenCalled();
    const escaped = setup(jsonSchema);
    await expect(
      escaped.writer.send([{ value: '\u0000'.repeat(1_000_000) }]),
    ).rejects.toBeInstanceOf(RangeError);
    expect(escaped.send).not.toHaveBeenCalled();
  });
});
