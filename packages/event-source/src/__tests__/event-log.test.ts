import { describe, expect, it } from 'vitest';
import { EventLog, createTableDiff } from '../index';

describe('EventLog append', () => {
  it('assigns monotonic seqs and auto-parents on the head', () => {
    const log = new EventLog();
    const first = log.append({ type: 'a', payload: 1 });
    const second = log.append({ type: 'b', payload: 2 });
    expect(first.seq).toBe(0);
    expect(first.parentSeq).toBeUndefined();
    expect(second.seq).toBe(1);
    expect(second.parentSeq).toBe(0);
    expect(log.head).toBe(1);
    expect(log.nextSeq).toBe(2);
    expect(log.size).toBe(2);
  });

  it('honours an explicit parentSeq and provenance metadata', () => {
    const log = new EventLog();
    log.append({ type: 'a', payload: 1 });
    const entry = log.append(
      { type: 'b', payload: 2 },
      { parentSeq: 0, clientId: 'c1', sessionId: 's1' },
    );
    expect(entry.parentSeq).toBe(0);
    expect(entry.clientId).toBe('c1');
    expect(entry.sessionId).toBe('s1');
  });

  it('carries tableDiffs when provided', () => {
    const log = new EventLog();
    const diff = createTableDiff('t', [{ op: 'delete', key: '1' }]);
    const entry = log.append({ type: 'a', payload: 1, tableDiffs: [diff] });
    expect(entry.tableDiffs).toEqual([diff]);
  });

  it('accepts an InputEvent shape and preserves its timestamp', () => {
    const log = new EventLog();
    const entry = log.append({ type: 'x', payload: { a: 1 }, timestamp: 999 });
    expect(entry.timestamp).toBe(999);
    expect(entry.payload).toEqual({ a: 1 });
  });
});

describe('EventLog commitAll', () => {
  it('wires the batch as one causal chain', () => {
    const log = new EventLog();
    log.append({ type: 'seed', payload: 0 });
    const batch = log.commitAll([
      { type: 'a', payload: 1 },
      { type: 'b', payload: 2 },
      { type: 'c', payload: 3 },
    ]);
    expect(batch.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(batch.map((e) => e.parentSeq)).toEqual([0, 1, 2]);
    expect(log.head).toBe(3);
  });

  it('is a no-op on empty input', () => {
    const log = new EventLog();
    expect(log.commitAll([])).toEqual([]);
    expect(log.isEmpty).toBe(true);
  });
});

function build3(): EventLog {
  const log = new EventLog();
  log.commitAll([
    { type: 'a', payload: 0 },
    { type: 'b', payload: 1 },
    { type: 'c', payload: 2 },
  ]);
  return log;
}

describe('EventLog queries', () => {
  it('getSince returns entries at or after the watermark', () => {
    const log = build3();
    expect(log.getSince(0).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(log.getSince(2).map((e) => e.seq)).toEqual([2]);
    expect(log.getSince(9)).toEqual([]);
  });

  it('getFrom pages with a hasMore flag', () => {
    const log = build3();
    const page = log.getFrom(0, 2);
    expect(page.entries.map((e) => e.seq)).toEqual([0, 1]);
    expect(page.hasMore).toBe(true);
    const rest = log.getFrom(2, 2);
    expect(rest.entries.map((e) => e.seq)).toEqual([2]);
    expect(rest.hasMore).toBe(false);
  });
});

describe('EventLog snapshot/load', () => {
  it('round-trips the log and resumes auto-parenting', () => {
    const log = build2();
    const snapshot = log.snapshot();
    expect(snapshot.version).toBe(2);
    expect(snapshot.epoch).toBe(log.getCheckpoint().epoch);
    expect(snapshot.head).toBe(1);
    expect(snapshot.nextSeq).toBe(2);

    const restored = new EventLog();
    restored.load(snapshot);
    const next = restored.append({ type: 'c', payload: 3 });
    expect(next.seq).toBe(2);
    expect(next.parentSeq).toBe(1);
  });

  it('snapshot of an empty log has a null head', () => {
    expect(new EventLog().snapshot().head).toBeNull();
  });

  it('rejects inconsistent snapshots', () => {
    const log = new EventLog();
    expect(() =>
      log.load({
        version: 2,
        epoch: 'test-epoch',
        entries: [{ seq: 4, type: 'a', payload: null, timestamp: 0 }],
        head: 4,
        nextSeq: 5,
      }),
    ).toThrow(/Invalid EventLog snapshot/);
  });

  it('detaches and freezes committed payloads', () => {
    const payload = { nested: { value: 1 } };
    const log = new EventLog();
    const entry = log.append({ type: 'a', payload });
    payload.nested.value = 2;
    expect(entry.payload).toEqual({ nested: { value: 1 } });
    expect(Object.isFrozen(entry.payload)).toBe(true);
  });

  it('clear resets seq and head', () => {
    const log = build2();
    const previousEpoch = log.getCheckpoint().epoch;
    log.clear();
    expect(log.isEmpty).toBe(true);
    expect(log.head).toBeNull();
    expect(log.getCheckpoint().epoch).not.toBe(previousEpoch);
    expect(log.append({ type: 'x', payload: 1 }).seq).toBe(0);
  });

  it('rejects unbounded or malformed page requests', () => {
    const log = build3();
    expect(() => log.getFrom(-1, 10)).toThrow(/cursor/);
    expect(() => log.getFrom(0, 1001)).toThrow(/limit/);
  });
});

describe('EventLog events generator', () => {
  it('yields entries from a watermark', async () => {
    const log = build2();
    const seen: number[] = [];
    for await (const entry of log.events(1)) seen.push(entry.seq);
    expect(seen).toEqual([1]);
  });
});

function build2(): EventLog {
  const log = new EventLog();
  log.append({ type: 'a', payload: 1 });
  log.append({ type: 'b', payload: 2 });
  return log;
}
