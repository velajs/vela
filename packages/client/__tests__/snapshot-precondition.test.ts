import { describe, expect, it } from 'vitest';
import { createSnapshotPrecondition, LiveClient } from '../src/index';
import { makeSocketFactory, tick } from './harness';

type Live = {
  'todos.list': { args: Record<string, never>; result: Array<{ id: string; done: boolean }> };
};

async function seeded() {
  const sockets = makeSocketFactory();
  const client = new LiveClient<Live>({
    url: 'http://api.test',
    WebSocket: sockets.factory,
    reconnect: { baseMs: 1, capMs: 2 },
  });
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

  it('is false when the value appeared after the snapshot', async () => {
    const { client, emit } = await seeded();
    const holds = createSnapshotPrecondition(client, 'todos.list', {}); // captured while undefined
    emit([{ id: 'a', done: false }], 1);
    expect(holds()).toBe(false);
  });

  it('is false when the value disappeared after the snapshot', async () => {
    const { client, emit, stop } = await seeded();
    emit([{ id: 'a', done: false }], 1);
    const holds = createSnapshotPrecondition(client, 'todos.list', {});
    stop(); // no more subscription → peek() is undefined
    expect(holds()).toBe(false);
  });

  it('is true when nothing existed then and nothing exists now', async () => {
    const { client } = await seeded();
    const holds = createSnapshotPrecondition(client, 'todos.list', {});
    expect(holds()).toBe(true);
  });
});
