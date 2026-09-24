import { emptyListSchema, emptyArgs, doneRows } from './schema-fixtures';
import { describe, expect, it } from 'vitest';
import {
  createMemoryMutationStore,
  createSnapshotPrecondition,
  getErrorCode,
  LiveClient,
  MutationQueue,
} from '../src/index';
import type {
  LiveClientOptions,
  MutationSettledEvent,
  MutationStore,
  OfflineQueueOptions,
  PersistedMutation,
} from '../src/types';
import { failingStore, makeSocketFactory, tick, wait } from './harness';

type Live = {
  'todos.list': { args: Record<string, never>; result: Array<{ id: string }> };
};

const ACCOUNT = { account: 'userA' } as const;

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
    mode: 'ok' as 'ok' | 'transport' | 'deferred',
    status: 200,
    headers: {} as Record<string, string>,
    body: { ok: true } as unknown,
    deferred: undefined as Promise<Response> | undefined,
  };
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    if (controller.mode === 'transport') throw new TypeError('Failed to fetch');
    if (controller.mode === 'deferred') {
      if (controller.deferred === undefined) throw new Error('missing deferred response');
      return controller.deferred;
    }
    return new Response(JSON.stringify(controller.body), {
      status: controller.status,
      headers: controller.headers,
    });
  }) as typeof fetch;

  const liveOptions: LiveClientOptions<Live> = {
    queries: [emptyListSchema],
    url: 'http://api.test',
    WebSocket: sockets.factory,
    reconnect: { baseMs: 1, capMs: 2 },
    fetch: fetchImpl,
    offline: options.offline ?? true,
    identity: options.identity ?? (() => 'userA'),
    ...(options.store === undefined ? {} : { mutationStore: options.store }),
    ...(options.persistenceVersion === undefined
      ? {}
      : { persistenceVersion: options.persistenceVersion }),
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
    await until(async () => (await store.load(ACCOUNT)).length === 1);

    h.controller.mode = 'transport';
    await h.client.flush();
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.client.pendingMutations()).toBe(1);
    expect(await store.load(ACCOUNT)).toHaveLength(1);

    h.controller.mode = 'ok';
    h.controller.headers = { 'Vela-Commit-Cursor': '2', 'Vela-Commit-Epoch': 'e1' };
    await h.client.flush();
    await promise;
    await until(async () => (await store.load(ACCOUNT)).length === 0);

    expect(h.fetchCalls).toHaveLength(2);
    expect(h.client.pendingMutations()).toBe(0);
  });

  it('does not auto-flush a newly queued write when hydration finishes after going offline', async () => {
    const backing = createMemoryMutationStore();
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const store: MutationStore = {
      append: (record, scope) => backing.append(record, scope),
      async load(scope) {
        await loadGate;
        return backing.load(scope);
      },
      remove: (id, scope) => backing.remove(id, scope),
      clear: (scope) => backing.clear(scope),
    };
    const h = makeClient({ offline: true, store });
    await goOffline(h);

    const pending = h.client.mutate('/queued-after-offline', {});
    const closed = rejectsWith(pending, 'CLIENT_CLOSED');
    expect(h.client.pendingMutations()).toBe(1);
    releaseLoad();
    await until(async () => (await backing.load(ACCOUNT)).length === 1);
    await tick();

    expect(h.client.pendingMutations()).toBe(1);
    expect(h.fetchCalls).toHaveLength(0);
    h.client.close();
    await closed;
  });
});

describe('offline mutation queue — replay guards', () => {
  it('requires an identity provider before offline persistence can be enabled', () => {
    expect(
      () =>
        new LiveClient<Live>({
          queries: [emptyListSchema],
          url: 'http://api.test',
          offline: true,
        }),
    ).toThrow(/identity provider/);
  });

  it('rejects cross-origin targets and never persists authorization headers', async () => {
    const store = createMemoryMutationStore();
    const h = makeClient({ offline: true, store });
    await goOffline(h);

    await expect(h.client.mutate('https://evil.example/write', {})).rejects.toMatchObject({
      code: 'INVALID_MUTATION_TARGET',
    });
    const pending = h.client.mutate('/safe', {}, { headers: { Authorization: 'Bearer stale' } });
    await until(async () => (await store.load(ACCOUNT)).length === 1);
    expect((await store.load(ACCOUNT))[0]?.headers).toBeUndefined();

    const closed = rejectsWith(pending, 'CLIENT_CLOSED');
    h.client.close();
    await closed;
  });

  it('purges a hostile persisted absolute target before replay', async () => {
    const store = createMemoryMutationStore();
    await store.append(
      { id: 'hostile', path: 'https://evil.example/write', identity: 'userA' },
      ACCOUNT,
    );

    const h = makeClient({ offline: true, store });
    await until(async () => (await store.load(ACCOUNT)).length === 0);
    expect(h.fetchCalls).toHaveLength(0);
  });

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
    await store.append(
      { id: 'm1', path: '/x', body: { v: 1 }, version: 'v1', identity: 'userA' },
      ACCOUNT,
    );

    const b = makeClient({ offline: true, store, persistenceVersion: 'v2' });
    await until(async () => (await store.load(ACCOUNT)).length === 0);
    expect(b.fetchCalls).toHaveLength(0);
  });

  it('never hydrates records from another account partition', async () => {
    const store = createMemoryMutationStore();
    await store.append({ id: 'm1', path: '/x', body: {}, identity: 'userA' }, ACCOUNT);

    const b = makeClient({ offline: true, store, identity: () => 'userB' });
    await tick();
    expect(b.client.pendingMutations()).toBe(0);
    expect(b.fetchCalls).toHaveLength(0);
    expect(await store.load(ACCOUNT)).toHaveLength(1);
  });

  it('purges only the previous account epoch and rejects its pending live writes', async () => {
    const store = createMemoryMutationStore();
    const accountB = { account: 'userB:epoch2' } as const;
    await store.append({ id: 'b1', path: '/keep', body: {}, identity: accountB.account }, accountB);
    let identity: string | null = 'userA:epoch1';
    const h = makeClient({ offline: true, store, identity: () => identity });
    await goOffline(h);
    const settled: MutationSettledEvent[] = [];
    h.client.onMutationSettled((event) => settled.push(event));

    const pending = h.client.mutate('/old-account-write', { value: 1 });
    const rejected = rejectsWith(pending, 'OFFLINE_IDENTITY_PURGED');
    await until(async () => (await store.load({ account: 'userA:epoch1' })).length === 1);

    identity = 'userB:epoch2';
    await expect(h.client.purgeOfflineMutations('userA:epoch1')).resolves.toBe(1);
    await rejected;

    expect(h.client.pendingMutations()).toBe(0);
    expect(await store.load({ account: 'userA:epoch1' })).toEqual([]);
    expect((await store.load(accountB)).map((record) => record.id)).toEqual(['b1']);
    expect(settled).toContainEqual({
      path: '/old-account-write',
      status: 'dropped',
      code: 'OFFLINE_IDENTITY_PURGED',
      hadAwaiter: true,
    });
  });

  it('refuses to purge the active account partition', async () => {
    const store = createMemoryMutationStore();
    await store.append({ id: 'm1', path: '/keep', identity: 'userA' }, ACCOUNT);
    const h = makeClient({ offline: true, store });

    await expect(h.client.purgeOfflineMutations('userA')).rejects.toMatchObject({
      code: 'OFFLINE_IDENTITY_STILL_ACTIVE',
    });
    expect((await store.load(ACCOUNT)).map((record) => record.id)).toEqual(['m1']);
  });

  it('orders a logout clear after an append already in flight', async () => {
    let releaseAppend!: () => void;
    let markAppendStarted!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const partitions = new Map<string, PersistedMutation[]>();
    let clears = 0;
    const store: MutationStore = {
      async append(record, { account }) {
        markAppendStarted();
        await appendGate;
        partitions.set(account, [...(partitions.get(account) ?? []), record]);
      },
      async load({ account }) {
        return [...(partitions.get(account) ?? [])];
      },
      async remove(id, { account }) {
        partitions.set(
          account,
          (partitions.get(account) ?? []).filter((record) => record.id !== id),
        );
      },
      async clear({ account }) {
        clears += 1;
        partitions.delete(account);
      },
    };
    let identity: string | null = 'userA';
    const h = makeClient({ offline: true, store, identity: () => identity });
    await goOffline(h);
    const pending = h.client.mutate('/x', {});
    const rejected = rejectsWith(pending, 'OFFLINE_IDENTITY_PURGED');
    await appendStarted;

    identity = null;
    const purge = h.client.purgeOfflineMutations('userA');
    await tick();
    expect(clears).toBe(0);
    releaseAppend();

    await expect(purge).resolves.toBe(1);
    await rejected;
    expect(clears).toBe(1);
    expect(await store.load(ACCOUNT)).toEqual([]);
  });

  it('aborts and rejects an old-epoch replay already drained for transport', async () => {
    const store = createMemoryMutationStore();
    let identity: string | null = 'userA';
    const h = makeClient({ offline: true, store, identity: () => identity });
    await goOffline(h);
    let resolveFetch!: (response: Response) => void;
    h.controller.deferred = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    h.controller.mode = 'deferred';
    const settled: MutationSettledEvent[] = [];
    h.client.onMutationSettled((event) => settled.push(event));
    const pending = h.client.mutate('/in-flight', {});
    const rejected = rejectsWith(pending, 'OFFLINE_IDENTITY_PURGED');
    await until(async () => (await store.load(ACCOUNT)).length === 1);

    const flushing = h.client.flush();
    await until(() => h.fetchCalls.length === 1);
    identity = 'userB';
    const purging = h.client.purgeOfflineMutations('userA');
    await rejected;
    expect((h.fetchCalls[0]?.init.signal as AbortSignal | undefined)?.aborted).toBe(true);

    // Simulate a transport that ignores AbortSignal and resolves anyway. The
    // retired response must not produce a second/committed terminal verdict.
    resolveFetch(new Response(JSON.stringify({ ok: true })));
    await flushing;
    await expect(purging).resolves.toBe(1);
    expect(await store.load(ACCOUNT)).toEqual([]);
    expect(settled.filter((event) => event.path === '/in-flight')).toEqual([
      {
        path: '/in-flight',
        status: 'dropped',
        code: 'OFFLINE_IDENTITY_PURGED',
        hadAwaiter: true,
      },
    ]);
  });

  it('keeps durable mutations on ordinary close for reload recovery', async () => {
    const store = createMemoryMutationStore();
    const h = makeClient({ offline: true, store });
    await goOffline(h);
    const pending = h.client.mutate('/survive-reload', {});
    const closed = rejectsWith(pending, 'CLIENT_CLOSED');
    await until(async () => (await store.load(ACCOUNT)).length === 1);

    h.client.close();
    await closed;

    expect((await store.load(ACCOUNT)).map((record) => record.path)).toEqual(['/survive-reload']);
  });

  it('caps and rewrites an oversized hydrated FIFO per account partition', async () => {
    const store = createMemoryMutationStore();
    for (const id of ['m1', 'm2', 'm3']) {
      await store.append({ id, path: '/x', identity: 'userA' }, ACCOUNT);
    }
    const queue = new MutationQueue({ maxItems: 2, account: () => 'userA', store });
    await queue.hydrate();

    expect(queue.size).toBe(2);
    expect((await store.load(ACCOUNT)).map((record) => record.id)).toEqual(['m2', 'm3']);
  });

  it('purges malformed, over-depth, and oversized hydrated records', async () => {
    const store = createMemoryMutationStore();
    await store.append(
      {
        id: 'oversized',
        path: '/x',
        identity: 'userA',
        body: { text: 'x'.repeat(1024 * 1024 + 1) },
      },
      ACCOUNT,
    );
    const invalid: unknown[] = [];
    const queue = new MutationQueue({
      maxItems: 10,
      account: () => 'userA',
      store,
      onInvalidHydrated: (record) => invalid.push(record),
    });
    await queue.hydrate();

    expect(queue.size).toBe(0);
    expect(invalid).toHaveLength(1);
    expect(await store.load(ACCOUNT)).toEqual([]);
  });

  it('rejects an un-encodable body terminally with no fetch and no requeue loop', async () => {
    const h = makeClient({ offline: true });
    await goOffline(h);
    const promise = rejectsWith(h.client.mutate('/x', { big: 10n }), 'OFFLINE_UNSERIALIZABLE');
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
    await store.append({ id: 'm1', path: '/x', body: {}, identity: 'userA' }, ACCOUNT);

    const b = makeClient({ offline: true, store });
    b.controller.status = 500;
    b.controller.body = { error: { code: 'boom', message: 'no' } };
    const settled = nextSettled(b.client);

    expect(await settled).toMatchObject({ status: 'rejected', hadAwaiter: false });
    expect(b.fetchCalls).toHaveLength(1);
  });

  it('replays an awaiter-less hydrated write exactly once after a reload', async () => {
    const store = createMemoryMutationStore();
    await store.append(
      { id: 'm1', path: '/todos', body: { text: 'x' }, identity: 'userA' },
      ACCOUNT,
    );

    const b = makeClient({ offline: true, store });
    b.controller.headers = { 'Vela-Commit-Cursor': '1', 'Vela-Commit-Epoch': 'e1' };
    const settled = nextSettled(b.client);

    expect(await settled).toMatchObject({ status: 'committed', hadAwaiter: false });
    expect(b.fetchCalls).toHaveLength(1);
    await until(async () => (await store.load(ACCOUNT)).length === 0);
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
