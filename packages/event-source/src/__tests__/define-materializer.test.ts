import { describe, expect, it, vi } from 'vitest';
import {
  defineMaterializer,
  EventLog,
  InMemorySnapshotStore,
  MaterializerRuntime,
  type EventLogEntry,
  type Materializer,
  type SnapshotStore,
} from '../index';

interface Count {
  count: number;
}

function parseCount(value: unknown): Count {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('count' in value) ||
    typeof value.count !== 'number' ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0
  ) {
    throw new TypeError('Invalid count snapshot');
  }
  return { count: value.count };
}

const makeWordCount = (): Materializer<Count> =>
  defineMaterializer<Count>({
    name: 'wordCount',
    parseSnapshot: parseCount,
    initial: () => ({ count: 0 }),
    handle: (state, entry) => (entry.type === 'word' ? { count: state.count + 1 } : state),
  });

const wordLog = (n: number): EventLog => {
  const log = new EventLog();
  log.commitAll(Array.from({ length: n }, (_, i) => ({ type: 'word', payload: i })));
  return log;
};

describe('defineMaterializer', () => {
  it('applies, resets, and replaces state', () => {
    const m = makeWordCount();
    m.apply({ seq: 0, type: 'word', payload: null, timestamp: 0 });
    expect(m.state.count).toBe(1);
    m.setState({ count: 40 });
    expect(m.state.count).toBe(40);
    m.reset();
    expect(m.state.count).toBe(0);
  });
});

describe('MaterializerRuntime applyEntries', () => {
  it('folds entries and tracks the watermark', () => {
    const m = makeWordCount();
    const rt = new MaterializerRuntime([m]);
    const applied = rt.applyEntries(wordLog(3).getSince(0));
    expect(applied).toBe(3);
    expect(m.state.count).toBe(3);
    expect(rt.appliedSeq).toBe(3);
  });

  it('skips entries at or below the watermark (idempotent)', () => {
    const m = makeWordCount();
    const rt = new MaterializerRuntime([m]);
    const entries = wordLog(2).getSince(0);
    rt.applyEntries(entries);
    // Re-applying the same batch is a no-op.
    const applied = rt.applyEntries(entries);
    expect(applied).toBe(0);
    expect(m.state.count).toBe(2);
  });

  it('catchUp pulls only entries after the watermark from a source', () => {
    const m = makeWordCount();
    const rt = new MaterializerRuntime([m]);
    const source = wordLog(2);
    rt.catchUp(source);
    source.append({ type: 'word', payload: 2 });
    const applied = rt.catchUp(source);
    expect(applied).toBe(1);
    expect(m.state.count).toBe(3);
  });

  it('catches up through bounded pages and refuses an excessive cold backlog', () => {
    const source = wordLog(1200);
    const getFrom = vi.spyOn(source, 'getFrom');
    const materializer = makeWordCount();
    const runtime = new MaterializerRuntime([materializer], {
      catchUpPageSize: 100,
      maxCatchUpEntries: 1200,
    });

    expect(runtime.catchUp(source)).toBe(1200);
    expect(getFrom).toHaveBeenCalledTimes(12);
    expect(getFrom.mock.calls.every(([, limit]) => limit === 100)).toBe(true);

    const capped = new MaterializerRuntime([makeWordCount()], { maxCatchUpEntries: 1199 });
    expect(() => capped.catchUp(source)).toThrow(/maxCatchUpEntries/);
    expect(capped.appliedSeq).toBe(0);
  });

  it('rejects oversized or discontinuous source pages before advancing', () => {
    const source = wordLog(2);
    const checkpoint = source.getCheckpoint();
    const entry = source.getFrom(0, 1).entries[0]!;
    const runtime = new MaterializerRuntime([makeWordCount()], { catchUpPageSize: 1 });
    expect(() =>
      runtime.catchUp({
        getCheckpoint: () => checkpoint,
        getFrom: () => ({ entries: [entry, entry], hasMore: false }),
      }),
    ).toThrow(/invalid or empty page/);
    expect(runtime.appliedSeq).toBe(0);
  });

  it('rejects a sequence gap without advancing state or watermark', () => {
    const m = makeWordCount();
    const rt = new MaterializerRuntime([m]);
    expect(() => rt.applyEntries([{ seq: 1, type: 'word', payload: null, timestamp: 0 }])).toThrow(
      /sequence gap/,
    );
    expect(m.state.count).toBe(0);
    expect(rt.appliedSeq).toBe(0);
  });

  it('rolls back in-place mutations when a later reducer poisons the event', () => {
    const mutable = defineMaterializer<{ count: number }>({
      name: 'mutable',
      initial: () => ({ count: 0 }),
      handle: (state) => {
        state.count += 1;
        return state;
      },
    });
    const poison = defineMaterializer<{ count: number }>({
      name: 'poison',
      initial: () => ({ count: 0 }),
      handle: () => {
        throw new Error('poison');
      },
    });
    const runtime = new MaterializerRuntime([mutable, poison]);

    expect(() =>
      runtime.applyEntries([{ seq: 0, type: 'security.changed', payload: null, timestamp: 0 }]),
    ).toThrow('poison');
    expect(mutable.state.count).toBe(0);
    expect(runtime.appliedSeq).toBe(0);
  });
});

describe('MaterializerRuntime unknown-event handling', () => {
  it('fails closed by default when no materializer reacts', () => {
    const rt = new MaterializerRuntime([makeWordCount()]);
    expect(() => rt.applyEntries([{ seq: 0, type: 'other', payload: null, timestamp: 0 }])).toThrow(
      /unhandled event type/,
    );
    expect(rt.appliedSeq).toBe(0);
  });

  it('warns only when explicitly configured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = new MaterializerRuntime([makeWordCount()], { unknownEventHandling: 'warn' });
    rt.applyEntries([{ seq: 0, type: 'other', payload: null, timestamp: 0 }]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('fail throws on an unhandled event', () => {
    const rt = new MaterializerRuntime([makeWordCount()], { unknownEventHandling: 'fail' });
    expect(() => rt.applyEntries([{ seq: 0, type: 'other', payload: null, timestamp: 0 }])).toThrow(
      /unhandled event type/,
    );
  });

  it('a callback observes unhandled events', () => {
    const seen: EventLogEntry[] = [];
    const rt = new MaterializerRuntime([makeWordCount()], {
      unknownEventHandling: (entry) => {
        seen.push(entry);
        return true;
      },
    });
    rt.applyEntries([{ seq: 0, type: 'other', payload: null, timestamp: 0 }]);
    expect(seen).toHaveLength(1);
  });
});

describe('MaterializerRuntime snapshot lifecycle', () => {
  it('restart-from-snapshot restores state and replays only newer entries', async () => {
    const store = new InMemorySnapshotStore();
    const source = wordLog(2); // seq 0,1

    const firstMaterializer = makeWordCount();
    const first = new MaterializerRuntime([firstMaterializer], { snapshotStore: store });
    first.catchUp(source);
    expect(firstMaterializer.state.count).toBe(2);
    await first.persistSnapshots();

    // New event arrives after the checkpoint.
    source.append({ type: 'word', payload: 2 }); // seq 2

    // Cold restart: fresh materializer + runtime over the same store.
    const secondMaterializer = makeWordCount();
    const handle = vi.spyOn(secondMaterializer, 'apply');
    const second = new MaterializerRuntime([secondMaterializer], { snapshotStore: store });
    const applied = await second.bootstrap(source);

    expect(applied).toBe(1); // only seq 2 replayed
    expect(handle).toHaveBeenCalledTimes(1); // seq 0,1 were NOT re-folded
    expect(secondMaterializer.state.count).toBe(3); // 2 restored + 1
    expect(second.appliedSeq).toBe(3);
  });

  it('persists projection state and watermark in one atomic store write', async () => {
    const store = new InMemorySnapshotStore();
    const save = vi.spyOn(store, 'save');
    const first = makeWordCount();
    const second = defineMaterializer<Count>({
      name: 'second',
      initial: () => ({ count: 0 }),
      handle: (state, entry) => (entry.type === 'word' ? { count: state.count + 1 } : state),
    });
    const runtime = new MaterializerRuntime([first, second], {
      snapshotStore: store,
      snapshotKey: 'security-projection/v1',
    });
    const source = wordLog(2);
    runtime.catchUp(source);

    await runtime.persistSnapshots();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      'security-projection/v1',
      expect.objectContaining({
        version: 2,
        sourceEpoch: source.getCheckpoint().epoch,
        appliedSeq: 2,
        states: { wordCount: { count: 2 }, second: { count: 2 } },
      }),
    );
  });

  it('reset returns to a cold start', () => {
    const m = makeWordCount();
    const rt = new MaterializerRuntime([m]);
    rt.applyEntries(wordLog(2).getSince(0));
    rt.reset();
    expect(m.state.count).toBe(0);
    expect(rt.appliedSeq).toBe(0);
  });

  it('ignores legacy non-atomic materializer checkpoints and rebuilds', async () => {
    const store = new InMemorySnapshotStore();
    await store.save('first', { appliedSeq: 2, state: { count: 2 } });
    await store.save('second', { appliedSeq: 3, state: { count: 3 } });
    const first = defineMaterializer<Count>({
      name: 'first',
      initial: () => ({ count: 0 }),
      handle: (state) => state,
    });
    const second = defineMaterializer<Count>({
      name: 'second',
      initial: () => ({ count: 0 }),
      handle: (state) => state,
    });
    const rt = new MaterializerRuntime([first, second], { snapshotStore: store });
    expect(await rt.recoverFromSnapshots()).toBe(0);
    expect(first.state.count).toBe(0);
    expect(second.state.count).toBe(0);
  });

  it('rejects a snapshot watermark beyond the source head and rebuilds', async () => {
    const store = new InMemorySnapshotStore();
    const source = wordLog(2);
    await store.save('projection/v1', {
      version: 2,
      sourceEpoch: source.getCheckpoint().epoch,
      appliedSeq: 99,
      states: { wordCount: { count: 99 } },
    });
    const materializer = makeWordCount();
    const runtime = new MaterializerRuntime([materializer], {
      snapshotStore: store,
      snapshotKey: 'projection/v1',
    });

    expect(await runtime.bootstrap(source)).toBe(2);
    expect(runtime.appliedSeq).toBe(2);
    expect(materializer.state.count).toBe(2);
  });

  it('rejects a future snapshot watermark when catchUp is called directly', async () => {
    const store = new InMemorySnapshotStore();
    const source = wordLog(2);
    await store.save('projection/v1', {
      version: 2,
      sourceEpoch: source.getCheckpoint().epoch,
      appliedSeq: 99,
      states: { wordCount: { count: 99 } },
    });
    const materializer = makeWordCount();
    const runtime = new MaterializerRuntime([materializer], {
      snapshotStore: store,
      snapshotKey: 'projection/v1',
    });

    await runtime.recoverFromSnapshots();
    expect(runtime.catchUp(source)).toBe(2);
    expect(materializer.state.count).toBe(2);
  });

  it('rebuilds when a snapshot belongs to a different log lineage', async () => {
    const store = new InMemorySnapshotStore();
    const original = wordLog(1);
    const firstMaterializer = makeWordCount();
    const first = new MaterializerRuntime([firstMaterializer], { snapshotStore: store });
    first.catchUp(original);
    await first.persistSnapshots();

    const replacement = wordLog(2);
    const nextMaterializer = makeWordCount();
    const next = new MaterializerRuntime([nextMaterializer], { snapshotStore: store });
    expect(await next.bootstrap(replacement)).toBe(2);
    expect(nextMaterializer.state.count).toBe(2);
  });

  it('detaches projection state from custom snapshot stores', async () => {
    let stored: unknown;
    const store: SnapshotStore = {
      save: (_key, value) => {
        stored = value;
        return Promise.resolve();
      },
      load: () => Promise.resolve(stored ?? null),
      list: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    const firstMaterializer = makeWordCount();
    const first = new MaterializerRuntime([firstMaterializer], { snapshotStore: store });
    first.catchUp(wordLog(1));
    await first.persistSnapshots();

    firstMaterializer.setState({ count: 500 });
    const secondMaterializer = makeWordCount();
    const second = new MaterializerRuntime([secondMaterializer], { snapshotStore: store });
    await second.recoverFromSnapshots();
    expect(secondMaterializer.state.count).toBe(1);

    const raw = stored as { states: { wordCount: Count } };
    raw.states.wordCount.count = 700;
    expect(secondMaterializer.state.count).toBe(1);
  });

  it('rejects duplicate materializer names', () => {
    expect(() => new MaterializerRuntime([makeWordCount(), makeWordCount()])).toThrow(/unique/);
  });
});

describe('MaterializerRuntime at-least-once discipline', () => {
  it('re-folds un-checkpointed entries on restart', async () => {
    const store = new InMemorySnapshotStore();
    const source = wordLog(2);
    let externalSideEffect = 0;
    const make = (): Materializer<Count> =>
      defineMaterializer<Count>({
        name: 'wc',
        initial: () => ({ count: 0 }),
        handle: (state, entry) => {
          if (entry.type !== 'word') return state;
          externalSideEffect += 1; // NON-idempotent side effect (the footgun)
          return { count: state.count + 1 };
        },
      });

    // Session 1 applies but "crashes" before persisting a checkpoint.
    const rt1 = new MaterializerRuntime([make()], { snapshotStore: store });
    rt1.catchUp(source);
    expect(externalSideEffect).toBe(2);

    // Session 2 has no checkpoint to resume from, so it re-folds from seq 0.
    const rt2 = new MaterializerRuntime([make()], { snapshotStore: store });
    await rt2.bootstrap(source);
    expect(externalSideEffect).toBe(4); // repeated → at-least-once
  });
});
