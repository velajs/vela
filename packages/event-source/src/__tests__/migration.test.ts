import { describe, expect, it, vi } from 'vitest';
import {
  EventLog,
  EventSource,
  defineMaterializer,
  MaterializerRuntime,
  InMemorySnapshotStore,
  isGlobalSeq,
  isClientSeq,
  isInputEvent,
  SubscriptionManager,
  defineEvents,
  payload,
  createTableDiff,
  mergeDiffs,
} from '../index';

const makeSource = () =>
  new EventSource(
    { count: 0 },
    (state, entry) => (entry.type === 'add' ? { count: state.count + 1 } : state),
    { unknownEventHandling: 'ignore' },
  );

function parseCount(value: unknown): { count: number } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('count' in value) ||
    typeof value.count !== 'number' ||
    !Number.isSafeInteger(value.count)
  )
    throw new Error('Invalid count');
  return { count: value.count };
}
const makeView = (name = 'count') =>
  defineMaterializer({
    name,
    initial: () => ({ count: 0 }),
    parseSnapshot: parseCount,
    handle: (state) => ({ count: state.count + 1 }),
  });

describe('portable log boundaries', () => {
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null])(
    'rejects invalid sequences: %s',
    (value) => {
      expect(isGlobalSeq(value)).toBe(false);
      expect(isClientSeq({ client: value, global: 0, rebaseGeneration: 0 })).toBe(false);
    },
  );

  it('checks every client sequence component and input timestamp', () => {
    expect(isClientSeq({ rebaseGeneration: 0 })).toBe(false);
    expect(isInputEvent({ type: 'x', payload: null, timestamp: 'today' })).toBe(false);
    expect(isInputEvent({ type: '', payload: null, timestamp: 0 })).toBe(false);
  });

  it.each([new Map(), new Date(), new Set(), { value: undefined }, NaN, 1n])(
    'rejects non-JSON payloads without committing',
    (value) => {
      const log = new EventLog();
      expect(() => log.append({ type: 'add', payload: value })).toThrow();
      expect(log.nextSeq).toBe(0);
    },
  );

  it('rejects cyclic data and malformed metadata, diffs, and snapshots', () => {
    const log = new EventLog();
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => log.append({ type: 'x', payload: cycle })).toThrow();
    expect(() => log.append({ type: '', timestamp: NaN })).toThrow();
    log.append({ type: 'seed' });
    const snapshot = log.snapshot();
    for (const invalid of [
      null,
      { ...snapshot, entries: [{ ...snapshot.entries[0], parentSeq: -1 }] },
      {
        ...snapshot,
        entries: [
          {
            ...snapshot.entries[0],
            tableDiffs: [{ table: 'x', timestamp: 0, changes: [{ op: 'oops', key: 'x' }] }],
          },
        ],
      },
    ]) {
      expect(() => log.load(invalid)).toThrow();
      expect(log.snapshot()).toEqual(snapshot);
    }
  });

  it('rejects a JSON array masquerading as a row-operation discriminator', () => {
    const log = new EventLog();
    const snapshot = log.snapshot();
    expect(() =>
      log.load({
        ...snapshot,
        head: 0,
        nextSeq: 1,
        entries: [
          {
            seq: 0,
            type: 'x',
            timestamp: 0,
            payload: null,
            tableDiffs: [
              { table: 'x', timestamp: 0, changes: [{ op: ['insert'], key: 'x', row: {} }] },
            ],
          },
        ],
      }),
    ).toThrow(/row change/);
    expect(log.size).toBe(0);
  });

  it('stages an entire batch before assigning positions', () => {
    const log = new EventLog();
    log.append({ type: 'seed' });
    expect(() => log.commitAll([{ type: 'valid' }, { type: 'bad', payload: new Map() }])).toThrow();
    expect(log.nextSeq).toBe(1);
    expect(log.head).toBe(0);
    expect(log.append({ type: 'retry' }).seq).toBe(1);
  });

  it('detaches and freezes causal metadata as well as payloads', () => {
    const parentSeq = { client: 1, global: 0, rebaseGeneration: 0 };
    const log = new EventLog();
    const entry = log.append({ type: 'x' }, { parentSeq });
    parentSeq.client = 99;
    expect(entry.parentSeq).toEqual({ client: 1, global: 0, rebaseGeneration: 0 });
    expect(Object.isFrozen(entry.parentSeq)).toBe(true);
  });

  it('blocks a reentrant appendChecked mutation', () => {
    const log = new EventLog();
    expect(() => log.appendChecked({ type: 'outer' }, () => log.append({ type: 'inner' }))).toThrow(
      /during/,
    );
    expect(log.size).toBe(0);
    expect(log.append({ type: 'retry' }).seq).toBe(0);
  });
});

describe('EventSource recovery and subscription correctness', () => {
  it('rolls back a mutating reducer and retries the same source position', () => {
    const log = new EventLog();
    log.append({ type: 'add' });
    let fail = true;
    const source = new EventSource({ nested: { count: 0 } }, (state) => {
      state.nested.count += 1;
      if (fail) throw new Error('poison');
      return { ...state };
    });
    expect(() => source.replayFrom(log)).toThrow('poison');
    expect(source.state.nested.count).toBe(0);
    expect(source.sourceWatermark).toBe(-1);
    expect(source.log.size).toBe(0);
    fail = false;
    source.replayFrom(log);
    expect(source.state.nested.count).toBe(1);
  });

  it('refuses a different lineage even when its sequence numbers overlap', () => {
    const original = new EventLog();
    original.append({ type: 'add' });
    const replacement = new EventLog();
    replacement.commitAll([{ type: 'add' }, { type: 'add' }]);
    const source = makeSource();
    source.replayFrom(original);
    expect(() => source.replayFrom(replacement)).toThrow(/lineage/);
    expect(source.state.count).toBe(1);
    source.reset({ count: 0 });
    expect(source.log.size).toBe(0);
    source.replayFrom(replacement);
    expect(source.state.count).toBe(2);
  });

  it('requires lineage for checkpoint resume and rejects future checkpoints', () => {
    const source = makeSource();
    expect(() => source.reset({ count: 1 }, 0)).toThrow(/epoch/);
    expect(() => source.reset({ count: 0 }, -2)).toThrow();
    const log = new EventLog();
    source.reset({ count: 1 }, 0, log.getCheckpoint().epoch);
    expect(() => source.replayFrom(log)).toThrow(/rewound/);
  });

  it('publishes committed watermarks and emits ready once', () => {
    const log = new EventLog();
    log.append({ type: 'add' });
    const source = makeSource();
    const ready = vi.fn();
    source.emitter.on('ready', ready);
    const watermarks: number[] = [];
    source.emitter.on('state-changed', () => watermarks.push(source.sourceWatermark));
    source.replayFrom(log);
    source.replayFrom(log);
    expect(watermarks).toEqual([0]);
    expect(ready).toHaveBeenCalledOnce();
  });

  it('streams each local position once during history drain, including ignored events', async () => {
    const source = makeSource();
    source.applyEvent({ type: 'add' });
    const iterator = source.events();
    expect((await iterator.next()).value?.seq).toBe(0);
    source.applyEvent({ type: 'add' });
    source.applyEvent({ type: 'ignored' });
    expect((await iterator.next()).value?.seq).toBe(1);
    expect((await iterator.next()).value?.seq).toBe(2);
    source.applyEvent({ type: 'add' });
    expect((await iterator.next()).value?.seq).toBe(3);
    await iterator.return(undefined);
    expect(source.emitter.listenerCount('event-applied')).toBe(0);
    expect(source.emitter.listenerCount('reset')).toBe(0);
  });

  it('cleans up an idle iterator on abort and on reset', async () => {
    for (const stop of ['abort', 'reset']) {
      const source = makeSource();
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const iterator = source.events(controller.signal);
      const waiting = iterator.next();
      if (stop === 'abort') controller.abort();
      else source.reset({ count: 0 });
      expect((await waiting).done).toBe(true);
      expect(source.emitter.listenerCount('event-applied')).toBe(0);
      expect(source.emitter.listenerCount('reset')).toBe(0);
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    }
  });

  it('keeps source and local stream sequence spaces separate after resume', async () => {
    const log = new EventLog();
    log.commitAll([{ type: 'add' }, { type: 'add' }]);
    const source = makeSource();
    source.reset({ count: 1 }, 0, log.getCheckpoint().epoch);
    const iterator = source.events();
    const waiting = iterator.next();
    source.replayFrom(log);
    expect((await waiting).value?.seq).toBe(0);
    await iterator.return(undefined);
    expect(source.sourceWatermark).toBe(1);
  });
});

describe('checkpoint safety', () => {
  it('rejects out-of-order delivery and tolerates duplicates around valid entries', () => {
    const view = makeView();
    const runtime = new MaterializerRuntime([view]);
    const log = new EventLog();
    const entries = log.commitAll([{ type: 'x' }, { type: 'x' }]);
    expect(() => runtime.applyEntries([entries[1]!])).toThrow(/gap/);
    expect(runtime.applyEntries([entries[0]!, entries[0]!, entries[1]!, entries[0]!])).toBe(2);
    expect(view.state.count).toBe(2);
  });

  it('rebuilds all views when any checkpoint state fails its parser', async () => {
    const store = new InMemorySnapshotStore();
    const log = new EventLog();
    log.append({ type: 'x' });
    await store.save('test', {
      version: 2,
      sourceEpoch: log.getCheckpoint().epoch,
      appliedSeq: 1,
      states: { first: { count: 99 }, second: { count: 'corrupt' } },
    });
    const first = makeView('first'),
      second = makeView('second');
    const runtime = new MaterializerRuntime([first, second], {
      snapshotStore: store,
      snapshotKey: 'test',
    });
    expect(await runtime.bootstrap(log)).toBe(1);
    expect(first.state.count).toBe(1);
    expect(second.state.count).toBe(1);
  });

  it('rebuilds checkpoints when no state parser exists', async () => {
    const store = new InMemorySnapshotStore();
    const log = new EventLog();
    log.append({ type: 'x' });
    const view = defineMaterializer({ name: 'count', initial: () => 0, handle: (s) => s + 1 });
    const runtime = new MaterializerRuntime([view], { snapshotStore: store });
    runtime.catchUp(log);
    await runtime.persistSnapshots();
    expect(await runtime.bootstrap(log)).toBe(1);
    expect(view.state).toBe(1);
  });

  it('orders overlapping saves and retries after a storage failure', async () => {
    const store = new InMemorySnapshotStore();
    const log = new EventLog();
    log.append({ type: 'x' });
    let finish: (() => void) | undefined;
    const save = vi.spyOn(store, 'save').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const runtime = new MaterializerRuntime([makeView()], {
      snapshotStore: store,
      snapshotKey: 'test',
    });
    runtime.catchUp(log);
    const first = runtime.persistSnapshots();
    log.append({ type: 'x' });
    runtime.catchUp(log);
    const second = runtime.persistSnapshots();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    finish!();
    await Promise.all([first, second]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(await store.load('test')).toMatchObject({
      appliedSeq: 2,
      states: { count: { count: 2 } },
    });
    save.mockRejectedValueOnce(new Error('unavailable'));
    await expect(runtime.persistSnapshots()).rejects.toThrow('unavailable');
    await runtime.persistSnapshots();
  });

  it('does not bind unverified direct delivery to an unrelated source', () => {
    const view = makeView();
    const runtime = new MaterializerRuntime([view]);
    const a = new EventLog();
    const b = new EventLog();
    runtime.applyEntries(a.commitAll([{ type: 'x' }, { type: 'x' }]));
    b.append({ type: 'x' });
    runtime.catchUp(b);
    expect(view.state.count).toBe(1);
  });
});

describe('helper contracts', () => {
  it('does not deliver the same dispatch to subscriptions added during callbacks', () => {
    const manager = new SubscriptionManager();
    const added = vi.fn();
    manager.onStateChange(() => manager.onStateChange(added));
    manager.notifyState({});
    expect(added).not.toHaveBeenCalled();
    manager.notifyState({});
    expect(added).toHaveBeenCalledOnce();
    manager.clear();
    expect(manager.size).toBe(0);
  });

  it('rejects ambiguous event vocabulary and cross-table merges', () => {
    expect(() => defineEvents({ _types: { event: payload() } })).toThrow();
    expect(() => defineEvents({ 'a.b': { c: payload() } })).toThrow();
    expect(() => mergeDiffs([createTableDiff('a', []), createTableDiff('b', [])])).toThrow(
      /different tables/,
    );
  });
});
