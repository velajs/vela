import { describe, expect, it } from 'vitest';
import type { MutationSettledEvent, PersistedMutation } from '@velajs/client';
import { createNativeClient } from '../src/create-native-client';
import { DEFAULT_MUTATION_STORE_KEY } from '../src/async-storage-store';
import { makeAsyncStorage, makeFetch, makeSocketFactory, tick } from './harness';

describe('createNativeClient — hydrate + replay over the AsyncStorage adapter', () => {
  it('replays a persisted mutation on hydrate and empties the durable store', async () => {
    const seeded: PersistedMutation[] = [
      {
        id: 'm1',
        path: '/todos',
        body: { text: 'hi' },
        method: 'POST',
        headers: { 'x-test': '1' },
        identity: 'userA',
      },
    ];
    const partitionKey = `${DEFAULT_MUTATION_STORE_KEY}:userA`;
    const storage = makeAsyncStorage({ [partitionKey]: JSON.stringify(seeded) });
    const sockets = makeSocketFactory();
    const { fetch, calls, response } = makeFetch();
    response.headers = { 'Vela-Commit-Cursor': '5', 'Vela-Commit-Epoch': 'e1' };

    // The queue hydrates from storage and flushes on construction (the same
    // flush a fresh 'connected' socket would trigger once online).
    const client = createNativeClient({
      url: 'http://api.test',
      storage,
      offline: true,
      fetch,
      WebSocket: sockets.factory,
      identity: () => 'userA',
    });

    const settled = new Promise<MutationSettledEvent>((resolve) => {
      const stop = client.onMutationSettled((event) => {
        stop();
        resolve(event);
      });
    });

    const event = await settled;
    expect(event.status).toBe('committed');
    expect(event.hadAwaiter).toBe(false); // hydrated record has no live awaiter

    // Replayed through fetch with the persisted path / method / body / headers.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://api.test/todos');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ text: 'hi' }));
    expect(new Headers(calls[0]?.init.headers).get('x-test')).toBe('1');

    // Durable store emptied (remove called after the commit).
    await tick();
    const remaining = JSON.parse(storage.map.get(partitionKey) ?? '[]') as PersistedMutation[];
    expect(remaining).toEqual([]);

    client.close();
  });
});
