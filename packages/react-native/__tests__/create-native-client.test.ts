import { describe, expect, it } from 'vitest';
import { LiveClient } from '@velajs/client';
import type { PersistedMutation } from '@velajs/client';
import { createMemoryMutationStore } from '@velajs/client/offline';
import { createNativeClient } from '../src/create-native-client';
import { DEFAULT_MUTATION_STORE_KEY } from '../src/async-storage-store';
// Barrel dogfooding (type-only → never loads `react` at runtime): the RN-added
// exports AND the re-exported `@velajs/react` hook-option surface both resolve
// from the package root without collision.
import type { AsyncStorageLike, CreateNativeClientOptions } from '../src/index';
import type { UseLiveQueryOptions } from '../src/index';
import { makeAsyncStorage, makeFetch, makeSocketFactory, tick } from './harness';

type AppLive = {
  'todos.list': { args: { listId: string }; result: Array<{ id: string }> };
};

const SLOW_RECONNECT = { baseMs: 60_000, capMs: 60_000 };

/** Subscribe, open the socket, then drop it — leaving the client proven-offline. */
async function goOffline(
  client: LiveClient<AppLive>,
  sockets: ReturnType<typeof makeSocketFactory>,
) {
  client.subscribe('todos.list', { listId: 'l1' }, () => {});
  await tick();
  sockets.last().open();
  sockets.last().dropFromServer();
}

describe('createNativeClient', () => {
  it('maps storage → offline MutationStore and defaults offline ON', async () => {
    const storage = makeAsyncStorage();
    const sockets = makeSocketFactory();
    const { fetch, calls } = makeFetch();
    const client = createNativeClient<AppLive>({
      url: 'http://api.test',
      storage,
      WebSocket: sockets.factory,
      fetch,
      reconnect: SLOW_RECONNECT,
    });

    await goOffline(client, sockets);
    const pending = client.mutate('/todos', { text: 'hi' });
    pending.catch(() => {}); // stays pending while offline; close() rejects it
    await tick();

    expect(client.pendingMutations()).toBe(1);
    expect(calls).toHaveLength(0); // enqueued, not fetched

    const stored = JSON.parse(
      storage.map.get(DEFAULT_MUTATION_STORE_KEY) ?? '[]',
    ) as PersistedMutation[];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.path).toBe('/todos');

    client.close();
  });

  it('threads the bearer token onto the HTTP mutation (authToken passthrough)', async () => {
    const { fetch, calls } = makeFetch();
    const client = createNativeClient<AppLive>({
      url: 'http://api.test',
      authToken: () => 'tok123',
      fetch,
    });

    await client.mutate('/todos', { text: 'hi' });

    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer tok123');
    client.close();
  });

  it('threads the bearer token onto the WebSocket connect URL (authToken passthrough)', async () => {
    const sockets = makeSocketFactory();
    const client = createNativeClient<AppLive>({
      url: 'http://api.test',
      authToken: () => 'tok123',
      WebSocket: sockets.factory,
    });

    client.subscribe('todos.list', { listId: 'l1' }, () => {});
    await tick();

    expect(sockets.last().url).toContain('?token=tok123');
    client.close();
  });

  it('lets an explicit mutationStore win over storage', async () => {
    const storage = makeAsyncStorage();
    const explicit = createMemoryMutationStore();
    const sockets = makeSocketFactory();
    const client = createNativeClient<AppLive>({
      url: 'http://api.test',
      storage,
      mutationStore: explicit,
      WebSocket: sockets.factory,
      fetch: makeFetch().fetch,
      reconnect: SLOW_RECONNECT,
    });

    await goOffline(client, sockets);
    const pending = client.mutate('/todos', { text: 'x' });
    pending.catch(() => {});
    await tick();

    expect(client.pendingMutations()).toBe(1);
    expect(storage.map.size).toBe(0); // storage-derived store never created
    expect(await explicit.load()).toHaveLength(1); // explicit store got the write

    client.close();
  });

  it('lets an explicit offline:false disable the queue even with storage', async () => {
    const storage = makeAsyncStorage();
    const sockets = makeSocketFactory();
    const { fetch, calls } = makeFetch();
    const client = createNativeClient<AppLive>({
      url: 'http://api.test',
      storage,
      offline: false,
      WebSocket: sockets.factory,
      fetch,
      reconnect: SLOW_RECONNECT,
    });

    await goOffline(client, sockets);
    await client.mutate('/todos', { text: 'x' }); // no queue → direct fetch even while offline

    expect(client.pendingMutations()).toBe(0);
    expect(calls).toHaveLength(1);
    client.close();
  });

  it('type-checks the exported signatures (dogfood, no casts)', () => {
    const acceptsQueryOptions = (_options?: UseLiveQueryOptions): void => {};
    acceptsQueryOptions();

    const storage: AsyncStorageLike = makeAsyncStorage();
    const options: CreateNativeClientOptions = { url: 'http://api.test', storage };
    const client: LiveClient<AppLive> = createNativeClient<AppLive>(options);

    expect(client).toBeInstanceOf(LiveClient);
    client.close();
  });
});
