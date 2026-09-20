import { emptyListSchema, emptyArgs, doneRows } from './schema-fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createSnapshotPrecondition, LiveClient } from '../src/index';
import { makeSocketFactory, tick } from './harness';

type Live = {
  'todos.list': { args: Record<string, never>; result: Array<{ id: string; done: boolean }> };
};

function unseeded() {
  const sockets = makeSocketFactory();
  const client = new LiveClient<Live>({
    queries: { 'todos.list': { args: { parse: emptyArgs }, result: { parse: doneRows } } },
    url: 'http://api.test',
    WebSocket: sockets.factory,
    reconnect: { baseMs: 1, capMs: 2 },
  });
  return { client, sockets };
}

async function seeded() {
  const { client, sockets } = unseeded();
  const stop = client.subscribe('todos.list', {}, () => {});
  await tick();
  sockets.last().open();
  const sub = (sockets.last().liveFrames()[0] as { sub: string }).sub;
  const emit = (snapshot: unknown, cursor: number) =>
    sockets.last().receive({ t: 'data', sub, snapshot, cursor, epoch: 'e1' });
  return { client, emit, stop };
}

describe('createSnapshotPrecondition', () => {
  it('is true while the value is unchanged', async () => {
    const { client, emit } = await seeded();
    emit([{ id: 'a', done: false }], 1);
    const holds = createSnapshotPrecondition(client, 'todos.list', {});
    expect(holds()).toBe(true);
    // Re-order of a keyed object still counts as unchanged (stable stringify).
    emit([{ done: false, id: 'a' }], 2);
    expect(holds()).toBe(true);
  });

  it('is false when the value changed', async () => {
    const { client, emit } = await seeded();
    emit([{ id: 'a', done: false }], 1);
    const holds = createSnapshotPrecondition(client, 'todos.list', {});
    emit([{ id: 'a', done: true }], 2);
    expect(holds()).toBe(false);
  });

  it('is false when a value appears while the subscription stays active', async () => {
    const { client, emit } = await seeded();
    const holds = createSnapshotPrecondition(client, 'todos.list', {});
    emit([{ id: 'a', done: false }], 1);
    expect(holds()).toBe(false);
  });

  it('is true when the originating subscription unmounted before replay', async () => {
    const { client, emit, stop } = await seeded();
    emit([{ id: 'a', done: false }], 1);
    const holds = createSnapshotPrecondition(client, 'todos.list', {});
    stop();
    expect(holds()).toBe(true);
  });

  it('is true when no subscription existed at either read', () => {
    const { client } = unseeded();
    const holds = createSnapshotPrecondition(client, 'todos.list', {});
    expect(holds()).toBe(true);
  });

  it('is true when an absent subscription becomes active before replay', async () => {
    const { client, sockets } = unseeded();
    const holds = createSnapshotPrecondition(client, 'todos.list', {});

    client.subscribe('todos.list', {}, () => {});
    await tick();
    sockets.last().open();
    const sub = (sockets.last().liveFrames()[0] as { sub: string }).sub;
    sockets.last().receive({
      t: 'data',
      sub,
      snapshot: [{ id: 'a', done: false }],
      cursor: 1,
      epoch: 'e1',
    });

    expect(holds()).toBe(true);
  });

  it('is true while an active subscription remains undefined', async () => {
    const { client } = await seeded();
    const holds = createSnapshotPrecondition(client, 'todos.list', {});
    expect(holds()).toBe(true);
  });

  it('is false when an active subscription becomes undefined', () => {
    const peekActiveQuerySnapshot = vi
      .fn()
      .mockReturnValueOnce({ present: true, value: [{ id: 'a', done: false }] })
      .mockReturnValueOnce({ present: true, value: undefined });
    const client = { peekActiveQuerySnapshot } as unknown as LiveClient<Live>;
    const holds = createSnapshotPrecondition(client, 'todos.list', {});
    expect(holds()).toBe(false);
  });

  it('reports active undefined separately from an absent subscription', async () => {
    const { client, stop } = await seeded();
    expect(client.peekActiveQuerySnapshot('todos.list', {})).toEqual({
      present: true,
      value: undefined,
    });

    stop();
    expect(client.peekActiveQuerySnapshot('todos.list', {})).toEqual({
      present: false,
      value: undefined,
    });
  });

  it('does not treat an unobserved hydration cache entry as an active subscription', () => {
    const { client } = unseeded();
    client.hydrate([
      {
        query: 'todos.list',
        args: {},
        value: [{ id: 'a', done: false }],
        cursor: 1,
        epoch: 'e1',
      },
    ]);

    expect(client.peek('todos.list', {})).toEqual([{ id: 'a', done: false }]);
    expect(client.peekActiveQuerySnapshot('todos.list', {})).toEqual({
      present: false,
      value: undefined,
    });
  });
});
