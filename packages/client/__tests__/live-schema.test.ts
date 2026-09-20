import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createLiveClient, LiveClient } from '../src';
import { emptyListSchema } from './schema-fixtures';
import { makeSocketFactory, tick } from './harness';

const queries = {
  'todos.list': {
    ...emptyListSchema,
    result: {
      parse(value: unknown) {
        const rows = emptyListSchema.result.parse(value);
        if (rows.some((row) => row.id === 'forbidden')) throw new Error('Reserved id');
        return rows;
      },
    },
  },
};

async function connected() {
  const sockets = makeSocketFactory();
  const client = createLiveClient({ url: 'https://api.test', queries, WebSocket: sockets.factory });
  const values: unknown[] = [];
  const onError = vi.fn();
  client.subscribe(
    'todos.list',
    {},
    (rows) => {
      expectTypeOf(rows).toEqualTypeOf<{ id: string }[] | undefined>();
      values.push(rows);
    },
    { onError },
  );
  await tick();
  sockets.last().open();
  const frame = sockets
    .last()
    .liveFrames()
    .find((frame) => frame.t === 'sub');
  if (!frame || frame.t !== 'sub') throw new Error('Missing subscription');
  return { client, sockets, values, onError, sub: frame.sub };
}

describe('runtime live schemas', () => {
  it('validates rows before committing snapshots and deltas, preserving the last good base', async () => {
    const { client, sockets, values, onError, sub } = await connected();
    sockets.last().receive({ t: 'data', sub, snapshot: [{ id: 'a' }], cursor: 1, epoch: 'e1' });
    const good = client.peek('todos.list', {});
    expect(good).toBe(client.peek('todos.list', {}));
    expect(values.at(-1)).toBe(good);
    sockets.last().receive({ t: 'data', sub, snapshot: [{ id: 42 }], cursor: 50, epoch: 'e1' });
    expect(client.peek('todos.list', {})).toBe(good);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'LIVE_SCHEMA_INVALID' }));
    // Cursor 2 remains admissible: rejected cursor 50 was never committed.
    sockets.last().receive({ t: 'data', sub, snapshot: [{ id: 'b' }], cursor: 2, epoch: 'e1' });
    expect(client.peek('todos.list', {})).toEqual([{ id: 'b' }]);
    sockets.last().receive({
      t: 'delta',
      sub,
      ops: [{ op: 'insert', key: 'forbidden', row: { id: 'forbidden' }, before: null }],
      cursor: 3,
      epoch: 'e1',
    });
    expect(client.peek('todos.list', {})).toEqual([{ id: 'b' }]);
    expect(onError).toHaveBeenCalledTimes(2);
    client.close();
  });

  it('validates arguments before opening a socket and SSR values before storing them', () => {
    const sockets = makeSocketFactory();
    const client = createLiveClient({
      url: 'https://api.test',
      queries,
      WebSocket: sockets.factory,
    });
    // @ts-expect-error intentional invalid runtime input
    expect(() => client.subscribe('todos.list', { invalid: true }, () => {})).toThrow(
      'Expected empty args',
    );
    expect(sockets.sockets).toHaveLength(0);
    client.hydrate([{ query: 'todos.list', args: {}, value: [{ id: 1 }], cursor: 1, epoch: 'e1' }]);
    expect(client.peek('todos.list', {})).toBeUndefined();
    client.hydrate([
      { query: 'todos.list', args: {}, value: [{ id: 'ok' }], cursor: 1, epoch: 'e1' },
    ]);
    expect(client.peek('todos.list', {})).toEqual([{ id: 'ok' }]);
    client.close();
  });
});

function negativeTypes() {
  const client = createLiveClient({ url: 'https://api.test', queries });
  // @ts-expect-error schema map controls query names
  client.subscribe('missing', {}, () => {});
  // @ts-expect-error typed clients require parser evidence
  new LiveClient<{ 'todos.list': { args: {}; result: { id: string }[] } }>({
    url: 'https://api.test',
  });
  new LiveClient<{ 'todos.list': { args: {}; result: number } }>({
    url: 'https://api.test',
    // @ts-expect-error an incorrect parser cannot satisfy the selected result
    queries,
  });
}
void negativeTypes;

it('adapts the native browser WebSocket events without asserting its shape', async () => {
  let latest: BrowserSocket | undefined;
  class BrowserSocket extends EventTarget {
    readyState = 0;
    sent: string[] = [];
    constructor(_url: string) {
      super();
      latest = this;
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    }
  }
  vi.stubGlobal('WebSocket', BrowserSocket);
  const client = createLiveClient({ url: 'https://api.test', queries });
  try {
    const seen: unknown[] = [];
    client.subscribe('todos.list', {}, (value) => seen.push(value));
    await tick();
    if (!latest) throw new Error('Expected browser socket');
    latest.open();
    const raw: unknown = JSON.parse(latest.sent[0] ?? 'null');
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('data' in raw) ||
      typeof raw.data !== 'object' ||
      raw.data === null ||
      !('sub' in raw.data)
    )
      throw new Error('Expected subscription');
    latest.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          event: '$live',
          data: {
            t: 'data',
            sub: raw.data.sub,
            snapshot: [{ id: 'browser' }],
            cursor: 1,
            epoch: 'e1',
          },
        }),
      }),
    );
    expect(seen.at(-1)).toEqual([{ id: 'browser' }]);
  } finally {
    client.close();
    vi.unstubAllGlobals();
  }
});

it('clears typed optimism on rejection before the first server snapshot', async () => {
  const sockets = makeSocketFactory();
  const client = createLiveClient({
    url: 'https://api.test',
    queries,
    WebSocket: sockets.factory,
    fetch: async () => new Response('rejected', { status: 500 }),
  });
  client.subscribe('todos.list', {}, () => {});
  try {
    await expect(
      client.mutate(
        '/todos',
        {},
        { optimistic: { query: 'todos.list', args: {}, apply: () => [{ id: 'temp' }] } },
      ),
    ).rejects.toThrow();
    expect(client.peek('todos.list', {})).toBeUndefined();
  } finally {
    client.close();
  }
});
