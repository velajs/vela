import { describe, expect, it } from 'vitest';
import { runProtocolConformance } from '@velajs/live-protocol';
import type { ClientLiveFrame, ServerLiveFrame } from '@velajs/live-protocol';
import { LiveClient } from '../src/live-client';
import type { WebSocketLike } from '../src/types';

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  dropFromServer(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  receive(frame: ServerLiveFrame): void {
    this.onmessage?.({ data: JSON.stringify({ event: '$live', data: frame }) });
  }

  liveFrames(): ClientLiveFrame[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as { event: string; data: ClientLiveFrame })
      .filter((envelope) => envelope.event === '$live')
      .map((envelope) => envelope.data);
  }
}

const tick = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  client: LiveClient;
  socket: () => FakeSocket;
  fetchCalls: Array<{ url: string; init: RequestInit }>;
  respondWith: (init: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  }) => void;
}

function makeHarness(): Harness {
  FakeSocket.instances = [];
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  let nextResponse: Response = new Response('{}', { status: 200 });

  const client = new LiveClient({
    url: 'http://api.test',
    WebSocket: (url) => new FakeSocket(url),
    reconnect: { baseMs: 1, capMs: 2 },
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return nextResponse.clone();
    }) as typeof fetch,
  });

  return {
    client,
    socket: () => {
      const socket = FakeSocket.instances.at(-1);
      if (!socket) throw new Error('no socket opened yet');
      return socket;
    },
    fetchCalls,
    respondWith: ({ status = 200, headers = {}, body = {} }) => {
      nextResponse = new Response(JSON.stringify(body), { status, headers });
    },
  };
}

describe('LiveClient subscriptions', () => {
  it('subscribes with the protocol version, dedupes identical subscriptions, replays cached values', async () => {
    const h = makeHarness();
    const seen: unknown[] = [];
    h.client.subscribe('todos.list', { listId: 'l1' }, (v) => seen.push(v));
    await tick();
    h.socket().open();

    const subs = h.socket().liveFrames();
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ t: 'sub', query: 'todos.list', args: { listId: 'l1' }, v: 1 });

    const sub = (subs[0] as { sub: string }).sub;
    h.socket().receive({ t: 'ack', sub });
    h.socket().receive({ t: 'data', sub, snapshot: [{ id: 'a' }], cursor: 1, epoch: 'e1' });
    expect(seen).toEqual([[{ id: 'a' }]]);

    // Args key is order-insensitive; the second subscriber joins the state.
    const late: unknown[] = [];
    h.client.subscribe('todos.list', { listId: 'l1' }, (v) => late.push(v));
    await tick();
    expect(late).toEqual([[{ id: 'a' }]]); // synchronous replay
    expect(h.socket().liveFrames()).toHaveLength(1); // still one wire registration
  });

  it('merges deltas, ignores settled, keeps values across resume', async () => {
    const h = makeHarness();
    const seen: unknown[] = [];
    h.client.subscribe('todos.list', {}, (v) => seen.push(v));
    await tick();
    h.socket().open();
    const sub = (h.socket().liveFrames()[0] as { sub: string }).sub;

    h.socket().receive({ t: 'data', sub, snapshot: [{ id: 'a', n: 1 }], cursor: 1, epoch: 'e1' });
    h.socket().receive({
      t: 'delta',
      sub,
      ops: [
        { op: 'insert', key: 'b', row: { id: 'b', n: 2 }, before: null },
        { op: 'update', key: 'a', row: { id: 'a', n: 9 } },
      ],
      cursor: 2,
      epoch: 'e1',
    });
    expect(seen.at(-1)).toEqual([
      { id: 'a', n: 9 },
      { id: 'b', n: 2 },
    ]);

    const count = seen.length;
    h.socket().receive({ t: 'settled', sub, cursor: 3, epoch: 'e1' });
    expect(seen.length).toBe(count); // no value change, no notify
    expect(h.client.peek('todos.list', {})).toEqual([
      { id: 'a', n: 9 },
      { id: 'b', n: 2 },
    ]);
  });

  it('resubscribes with the last cursor on reconnect and keeps the value on resume', async () => {
    const h = makeHarness();
    const seen: unknown[] = [];
    h.client.subscribe('todos.list', {}, (v) => seen.push(v));
    await tick();
    h.socket().open();
    const first = h.socket();
    const sub = (first.liveFrames()[0] as { sub: string }).sub;
    first.receive({ t: 'data', sub, snapshot: [{ id: 'a' }], cursor: 7, epoch: 'e1' });

    first.dropFromServer();
    await wait(15); // jittered reconnect (baseMs 1 / capMs 2)
    await tick();
    const second = h.socket();
    expect(second).not.toBe(first);
    second.open();

    expect(second.liveFrames()[0]).toMatchObject({
      t: 'sub',
      sub,
      sinceCursor: 7,
      sinceEpoch: 'e1',
    });

    second.receive({ t: 'resume', sub, cursor: 9, epoch: 'e1' });
    expect(h.client.peek('todos.list', {})).toEqual([{ id: 'a' }]); // cache kept
    expect(seen.at(-1)).toEqual([{ id: 'a' }]);
  });

  it('starts cold (unsub + sub) when a delta cannot be merged', async () => {
    const h = makeHarness();
    h.client.subscribe('todos.list', {}, () => {});
    await tick();
    h.socket().open();
    const sub = (h.socket().liveFrames()[0] as { sub: string }).sub;

    h.socket().receive({ t: 'data', sub, snapshot: { notAList: true }, cursor: 1, epoch: 'e1' });
    h.socket().receive({
      t: 'delta',
      sub,
      ops: [{ op: 'delete', key: 'x' }],
      cursor: 2,
      epoch: 'e1',
    });

    const frames = h.socket().liveFrames();
    expect(frames.at(-2)).toEqual({ t: 'unsub', sub });
    expect(frames.at(-1)).toMatchObject({ t: 'sub', sub, query: 'todos.list' });
    expect((frames.at(-1) as { sinceCursor?: number }).sinceCursor).toBeUndefined(); // cold
  });

  it('drops optimistic gates and cache on an epoch fork', async () => {
    const h = makeHarness();
    const seen: unknown[] = [];
    h.client.subscribe('todos.list', {}, (v) => seen.push(v));
    await tick();
    h.socket().open();
    const sub = (h.socket().liveFrames()[0] as { sub: string }).sub;

    h.socket().receive({ t: 'data', sub, snapshot: [{ id: 'a' }], cursor: 5, epoch: 'e1' });
    h.respondWith({ headers: { 'Vela-Commit-Cursor': '9', 'Vela-Commit-Epoch': 'e1' } });
    await h.client.mutate(
      '/todos',
      { text: 'x' },
      {
        optimistic: {
          query: 'todos.list',
          args: {},
          apply: (t) => [...((t as unknown[]) ?? []), { id: 'tmp' }],
        },
      },
    );
    expect((h.client.peek('todos.list', {}) as unknown[]).length).toBe(2); // overlay pending (cursor 9 > 5)

    // Server restarted: new epoch. The stale gate must not survive the fork.
    h.socket().receive({ t: 'data', sub, snapshot: [{ id: 'z' }], cursor: 1, epoch: 'e2' });
    expect(h.client.peek('todos.list', {})).toEqual([{ id: 'z' }]);
  });
});

describe('optimistic mutations', () => {
  async function subscribed(h: Harness): Promise<{ sub: string; values: unknown[] }> {
    const values: unknown[] = [];
    h.client.subscribe('todos.list', {}, (v) => values.push(v));
    await tick();
    h.socket().open();
    const sub = (h.socket().liveFrames()[0] as { sub: string }).sub;
    h.socket().receive({ t: 'data', sub, snapshot: [{ id: 'a' }], cursor: 1, epoch: 'e1' });
    return { sub, values };
  }

  it('paints immediately, rebases across unrelated frames, drops only when the cursor passes', async () => {
    const h = makeHarness();
    const { sub } = await subscribed(h);

    h.respondWith({ headers: { 'Vela-Commit-Cursor': '5', 'Vela-Commit-Epoch': 'e1' } });
    const mutation = h.client.mutate(
      '/todos',
      { text: 'new' },
      {
        optimistic: {
          query: 'todos.list',
          args: {},
          apply: (todos) => [...((todos as unknown[]) ?? []), { id: 'tmp', text: 'new' }],
        },
      },
    );
    // Painted synchronously.
    expect((h.client.peek('todos.list', {}) as unknown[]).at(-1)).toEqual({
      id: 'tmp',
      text: 'new',
    });

    await mutation;
    // Unrelated frame below the commit cursor: the layer REBASES onto the new base.
    h.socket().receive({
      t: 'delta',
      sub,
      ops: [{ op: 'insert', key: 'b', row: { id: 'b' }, before: null }],
      cursor: 3,
      epoch: 'e1',
    });
    const rebased = h.client.peek('todos.list', {}) as unknown[];
    expect(rebased.map((row) => (row as { id: string }).id)).toEqual(['a', 'b', 'tmp']);

    // The covering frame (cursor 5) carries the authoritative row: layer drops.
    h.socket().receive({
      t: 'delta',
      sub,
      ops: [{ op: 'insert', key: 'real', row: { id: 'real', text: 'new' }, before: null }],
      cursor: 5,
      epoch: 'e1',
    });
    const settled = h.client.peek('todos.list', {}) as unknown[];
    expect(settled.map((row) => (row as { id: string }).id)).toEqual(['a', 'b', 'real']);
  });

  it('drops immediately when the covering frame beat the HTTP response', async () => {
    const h = makeHarness();
    const { sub } = await subscribed(h);

    // The confirming settled frame arrives BEFORE the mutation resolves.
    h.respondWith({ headers: { 'Vela-Commit-Cursor': '2', 'Vela-Commit-Epoch': 'e1' } });
    const mutation = h.client.mutate(
      '/todos/a',
      { done: true },
      {
        method: 'PATCH',
        optimistic: {
          query: 'todos.list',
          args: {},
          apply: (todos) => (todos as Array<{ id: string }>).map((t) => ({ ...t, done: true })),
        },
      },
    );
    h.socket().receive({ t: 'settled', sub, cursor: 2, epoch: 'e1' });
    await mutation;

    // Base never changed (settled), so after the drop the raw base shows.
    expect(h.client.peek('todos.list', {})).toEqual([{ id: 'a' }]);
  });

  it('degrades to one-shot optimism without commit headers and rolls back on failure', async () => {
    const h = makeHarness();
    await subscribed(h);

    h.respondWith({}); // no commit headers
    await h.client.mutate(
      '/todos',
      {},
      {
        optimistic: { query: 'todos.list', args: {}, apply: () => [{ id: 'oneshot' }] },
      },
    );
    // Layer dropped silently on success — value reconciles to the base on the next fold-triggering event.

    h.respondWith({ status: 500, body: { error: { code: 'boom', message: 'nope' } } });
    await expect(
      h.client.mutate(
        '/todos',
        {},
        {
          optimistic: { query: 'todos.list', args: {}, apply: () => [{ id: 'doomed' }] },
        },
      ),
    ).rejects.toMatchObject({ code: 'boom', status: 500 });
    expect(h.client.peek('todos.list', {})).toEqual([{ id: 'a' }]); // rolled back
  });

  it('updates several subscriptions through optimisticUpdate and sends auth on mutations', async () => {
    const h = makeHarness();
    await subscribed(h);

    h.respondWith({ headers: { 'Vela-Commit-Cursor': '4', 'Vela-Commit-Epoch': 'e1' } });
    await h.client.mutate(
      '/todos',
      {},
      {
        optimisticUpdate: (store) => {
          store.set('todos.list', {}, (current) => [
            ...((current as unknown[]) ?? []),
            { id: 'multi' },
          ]);
          store.set('missing.query', {}, () => ['ignored']); // no live subscription → no-op
        },
      },
    );
    expect((h.client.peek('todos.list', {}) as unknown[]).at(-1)).toEqual({ id: 'multi' });

    expect(h.fetchCalls[0].url).toBe('http://api.test/todos');
    expect(h.fetchCalls[0].init.method).toBe('POST');
  });
});

describe('protocol conformance', () => {
  it('the shared codec this client links passes the golden fixtures', () => {
    expect(runProtocolConformance().failures).toEqual([]);
  });
});
