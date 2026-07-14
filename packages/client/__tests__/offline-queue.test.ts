import { describe, expect, it } from 'vitest';
import {
  createMemoryMutationStore,
  createSnapshotPrecondition,
  getErrorCode,
  LiveClient,
} from '../src/index';
import type {
  LiveClientOptions,
  MutationSettledEvent,
  MutationStore,
  OfflineQueueOptions,
} from '../src/types';
import { failingStore, makeSocketFactory, tick, wait } from './harness';

type Live = {
  'todos.list': { args: Record<string, never>; result: Array<{ id: string }> };
};

interface HarnessOptions {
  offline?: boolean | OfflineQueueOptions;
  store?: MutationStore;
  persistenceVersion?: string;
  identity?: () => string | null | undefined;
}

function makeClient(options: HarnessOptions = {}) {
  const sockets = makeSocketFactory();
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const controller = {
    mode: 'ok' as 'ok' | 'transport',
    status: 200,
    headers: {} as Record<string, string>,
    body: { ok: true } as unknown,
  };
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    if (controller.mode === 'transport') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(controller.body), {
      status: controller.status,
      headers: controller.headers,
    });
  }) as typeof fetch;

  const liveOptions: LiveClientOptions = {
    url: 'http://api.test',
    WebSocket: sockets.factory,
    reconnect: { baseMs: 1, capMs: 2 },
    fetch: fetchImpl,
    offline: options.offline ?? true,
    ...(options.store === undefined ? {} : { mutationStore: options.store }),
    ...(options.persistenceVersion === undefined
      ? {}
      : { persistenceVersion: options.persistenceVersion }),
    ...(options.identity === undefined ? {} : { identity: options.identity }),
  };
  const client = new LiveClient<Live>(liveOptions);
  return { client, sockets, fetchCalls, controller };
}

type Harness = ReturnType<typeof makeClient>;

/** Bring a subscribed client to a proven-offline state (connected → dropped). */
async function goOffline(h: Harness): Promise<{ sub: string }> {
  h.client.subscribe('todos.list', {}, () => {});
  await tick();
  h.sockets.last().open();
  const sub = (h.sockets.last().liveFrames()[0] as { sub: string }).sub;
  h.sockets.last().receive({ t: 'data', sub, snapshot: [], cursor: 1, epoch: 'e1' });
  h.sockets.last().dropFromServer();
  return { sub };
}

const rejectsWith = (promise: Promise<unknown>, code: string): Promise<void> =>
  promise.then(
    () => {
      throw new Error(`expected rejection with code ${code}`);
    },
    (error: unknown) => {
      expect(getErrorCode(error)).toBe(code);
    },
  );

const nextSettled = (client: LiveClient<Live>): Promise<MutationSettledEvent> =>
  new Promise((resolve) => {
    const stop = client.onMutationSettled((event) => {
      stop();
      resolve(event);
    });
  });

async function until(predicate: () => boolean | Promise<boolean>, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return;
    await tick();
  }
  throw new Error('condition not met in time');
}

describe('offline mutation queue — replay', () => {
  it('queues while offline, does not fetch, then replays exactly once on reconnect', async () => {
    const h = makeClient({ offline: true });
    await goOffline(h);
    h.controller.headers = { 'Vela-Commit-Cursor': '5', 'Vela-Commit-Epoch': 'e1' };

    const promise = h.client.mutate(
      '/todos',
      { text: 'x' },
      {
        optimistic: {
          query: 'todos.list',
          args: {},
          apply: (t) => [...(Array.isArray(t) ? t : []), { id: 'tmp' }],
        },
      },
    );
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.client.pendingMutations()).toBe(1);
    expect((h.client.peek('todos.list', {}) ?? []).some((row) => row.id === 'tmp')).toBe(true);

    await wait(15);
    await tick();
    h.sockets.last().open();
    await promise;

    expect(h.fetchCalls).toHaveLength(1);
    expect(h.client.pendingMutations()).toBe(0);

    // A covering frame drops the optimistic layer that the replay confirmed.
    const sub = (h.sockets.last().liveFrames()[0] as { sub: string }).sub;
    h.sockets.last().receive({ t: 'settled', sub, cursor: 5, epoch: 'e1' });
    expect((h.client.peek('todos.list', {}) ?? []).some((row) => row.id === 'tmp')).toBe(false);
  });

  it('preserves FIFO order across a multi-write flush', async () => {
    const h = makeClient({ offline: true });
    await goOffline(h);
    h.controller.headers = { 'Vela-Commit-Cursor': '1', 'Vela-Commit-Epoch': 'e1' };
    const writes = [h.client.mutate('/a'), h.client.mutate('/b'), h.client.mutate('/c')];
    expect(h.fetchCalls).toHaveLength(0);

    await h.client.flush();
    await Promise.all(writes);

    expect(h.fetchCalls.map((call) => call.url)).toEqual([
      'http://api.test/a',
      'http://api.test/b',
      'http://api.test/c',
    ]);
  });

  it('evicts the oldest write past the cap with OFFLINE_QUEUE_OVERFLOW', async () => {
    const h = makeClient({ offline: { maxItems: 2 } });
    await goOffline(h);
    const settled: MutationSettledEvent[] = [];
    h.client.onMutationSettled((event) => settled.push(event));

    const first = rejectsWith(h.client.mutate('/a'), 'OFFLINE_QUEUE_OVERFLOW');
    const p2 = h.client.mutate('/b');
    const p3 = h.client.mutate('/c');
    await first;

    expect(h.client.pendingMutations()).toBe(2);
    expect(
      settled.some(
        (event) => event.code === 'OFFLINE_QUEUE_OVERFLOW' && event.status === 'dropped',
      ),
    ).toBe(true);

    const closed2 = rejectsWith(p2, 'CLIENT_CLOSED');
    const closed3 = rejectsWith(p3, 'CLIENT_CLOSED');
    h.client.close();
    await Promise.all([closed2, closed3]);
  });

  it('keeps a write durable on a transport error and retries it on the next flush', async () => {
    const store = createMemoryMutationStore();
    const h = makeClient({ offline: true, store });
    await goOffline(h);
    const promise = h.client.mutate('/todos', { text: 'x' });
    expect(h.client.pendingMutations()).toBe(1);
    await until(async () => (await store.load()).length === 1);

    h.controller.mode = 'transport';
    await h.client.flush();
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.client.pendingMutations()).toBe(1);
    expect(await store.load()).toHaveLength(1);

    h.controller.mode = 'ok';
    h.controller.headers = { 'Vela-Commit-Cursor': '2', 'Vela-Commit-Epoch': 'e1' };
    await h.client.flush();
    await promise;
    await until(async () => (await store.load()).length === 0);

    expect(h.fetchCalls).toHaveLength(2);
    expect(h.client.pendingMutations()).toBe(0);
  });
});

describe('offline mutation queue — replay guards', () => {
  it('drops a queued write whose precondition fails, without fetching', async () => {
    const h = makeClient({ offline: true });
    await goOffline(h);
    const promise = rejectsWith(
      h.client.mutate('/todos/a', { done: true }, { precondition: () => false }),
      'OFFLINE_PRECONDITION_FAILED',
    );
    expect(h.client.pendingMutations()).toBe(1);

    await h.client.flush();
    await promise;
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.client.pendingMutations()).toBe(0);
  });

  it('purges a stale-version record on hydrate instead of replaying it', async () => {
    const store = createMemoryMutationStore();
    await store.append({ id: 'm1', path: '/x', body: { v: 1 }, version: 'v1' });

    const b = makeClient({ offline: true, store, persistenceVersion: 'v2' });
    await until(async () => (await store.load()).length === 0);
    expect(b.fetchCalls).toHaveLength(0);
  });

  it('drops a hydrated write whose identity no longer matches', async () => {
    const store = createMemoryMutationStore();
    await store.append({ id: 'm1', path: '/x', body: {}, identity: 'userA' });

    const b = makeClient({ offline: true, store, identity: () => 'userB' });
    const settled = nextSettled(b.client);
    const event = await settled;

    expect(event).toMatchObject({
      status: 'dropped',
      code: 'OFFLINE_IDENTITY_MISMATCH',
      hadAwaiter: false,
    });
    expect(b.fetchCalls).toHaveLength(0);
  });

  it('rejects an un-encodable body terminally with no fetch and no requeue loop', async () => {
    const h = makeClient({ offline: true });
    await goOffline(h);
    const promise = rejectsWith(h.client.mutate('/x', { big: 10n }), 'OFFLINE_UNSERIALIZABLE');
    expect(h.client.pendingMutations()).toBe(1);

    await h.client.flush();
    await promise;
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.client.pendingMutations()).toBe(0);
  });

  it('reports a MutationStore failure through onError', async () => {
    const errors: Array<{ operation: string }> = [];
    const h = makeClient({
      offline: { onError: (ctx) => errors.push(ctx) },
      store: failingStore('append'),
    });
    await goOffline(h);
    const promise = rejectsWith(h.client.mutate('/x', {}), 'CLIENT_CLOSED');

    await until(() => errors.some((entry) => entry.operation === 'append'));
    expect(errors.some((entry) => entry.operation === 'append')).toBe(true);

    h.client.close();
    await promise;
  });
});

describe('offline mutation queue — settled observer', () => {
  it('reports a committed live write with hadAwaiter true', async () => {
    const h = makeClient({ offline: true });
    await goOffline(h);
    h.controller.headers = { 'Vela-Commit-Cursor': '1', 'Vela-Commit-Epoch': 'e1' };

    const settled = nextSettled(h.client);
    const promise = h.client.mutate('/x', {});
    await h.client.flush();
    await promise;

    expect(await settled).toMatchObject({ status: 'committed', hadAwaiter: true, path: '/x' });
  });

  it('reports a rejected hydrated write with hadAwaiter false across a reload', async () => {
    const store = createMemoryMutationStore();
    await store.append({ id: 'm1', path: '/x', body: {} });

    const b = makeClient({ offline: true, store });
    b.controller.status = 500;
    b.controller.body = { error: { code: 'boom', message: 'no' } };
    const settled = nextSettled(b.client);

    expect(await settled).toMatchObject({ status: 'rejected', hadAwaiter: false });
    expect(b.fetchCalls).toHaveLength(1);
  });

  it('replays an awaiter-less hydrated write exactly once after a reload', async () => {
    const store = createMemoryMutationStore();
    await store.append({ id: 'm1', path: '/todos', body: { text: 'x' } });

    const b = makeClient({ offline: true, store });
    b.controller.headers = { 'Vela-Commit-Cursor': '1', 'Vela-Commit-Epoch': 'e1' };
    const settled = nextSettled(b.client);

    expect(await settled).toMatchObject({ status: 'committed', hadAwaiter: false });
    expect(b.fetchCalls).toHaveLength(1);
    await until(async () => (await store.load()).length === 0);
  });
});

describe('offline OCC end-to-end', () => {
  it('drops an offline write whose target diverged before reconnect', async () => {
    const h = makeClient({ offline: true });
    const { sub } = await goOffline(h);
    // Snapshot the (empty) list, then a mutate gated on it.
    const precondition = createSnapshotPrecondition(h.client, 'todos.list', {});
    const dropped = rejectsWith(
      h.client.mutate('/todos/a', { done: true }, { precondition }),
      'OFFLINE_PRECONDITION_FAILED',
    );
    expect(h.client.pendingMutations()).toBe(1);

    // Reconnect, then diverge the live value BEFORE the socket opens (and the
    // reconnect auto-flush runs) so the replay sees the changed value.
    await wait(15);
    await tick();
    h.sockets.last().receive({ t: 'data', sub, snapshot: [{ id: 'x' }], cursor: 2, epoch: 'e1' });
    h.sockets.last().open();

    await dropped;
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.client.pendingMutations()).toBe(0);
  });
});
