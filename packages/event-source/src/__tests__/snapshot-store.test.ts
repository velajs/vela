import { describe, expect, it } from 'vitest';
import { InMemorySnapshotStore } from '../index';

describe('InMemorySnapshotStore', () => {
  it('saves and loads by key', async () => {
    const store = new InMemorySnapshotStore();
    await store.save('a', { n: 1 });
    expect(await store.load('a')).toEqual({ n: 1 });
  });

  it('returns null for a missing key', async () => {
    const store = new InMemorySnapshotStore();
    expect(await store.load('missing')).toBeNull();
  });

  it('deep-copies on save so a later mutation cannot leak in', async () => {
    const store = new InMemorySnapshotStore();
    const value = { nested: { n: 1 } };
    await store.save('a', value);
    value.nested.n = 999;
    expect(await store.load('a')).toEqual({ nested: { n: 1 } });
  });

  it('deep-copies on load so consumers cannot mutate stored state', async () => {
    const store = new InMemorySnapshotStore();
    await store.save('a', { nested: { n: 1 } });
    const loaded = (await store.load('a')) as { nested: { n: number } };
    loaded.nested.n = 999;
    expect(await store.load('a')).toEqual({ nested: { n: 1 } });
  });

  it('lists keys and deletes / clears', async () => {
    const store = new InMemorySnapshotStore();
    await store.save('a', 1);
    await store.save('b', 2);
    expect((await store.list()).toSorted()).toEqual(['a', 'b']);
    await store.delete('a');
    expect(await store.list()).toEqual(['b']);
    await store.clear();
    expect(await store.list()).toEqual([]);
  });
});
