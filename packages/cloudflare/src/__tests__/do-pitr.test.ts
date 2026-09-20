import { describe, expect, it } from 'vitest';
import {
  armDoPitr,
  DoPitrUnavailableError,
  isDoPitrUnavailable,
  readDoPitrBookmark,
} from '../websocket/do-pitr';
import type { DoPitrStorage } from '../websocket/do-pitr';

/** A fake SQLite-backed DO storage exposing the full bookmark API. */
class FakeSqliteStorage implements DoPitrStorage {
  readonly armed: string[] = [];
  readonly forTimeCalls: Array<number | Date> = [];
  constructor(
    private readonly current = 'bm-current',
    private readonly byTime = 'bm-for-time',
    private readonly undo = 'bm-undo',
  ) {}
  getCurrentBookmark(): Promise<string> {
    return Promise.resolve(this.current);
  }
  getBookmarkForTime(timestamp: number | Date): Promise<string> {
    this.forTimeCalls.push(timestamp);
    return Promise.resolve(this.byTime);
  }
  onNextSessionRestoreBookmark(bookmark: string): Promise<string> {
    this.armed.push(bookmark);
    return Promise.resolve(this.undo);
  }
}

describe('do-pitr — readDoPitrBookmark', () => {
  it('returns the current bookmark, and the by-time bookmark when a time is given', async () => {
    const storage = new FakeSqliteStorage();

    expect(await readDoPitrBookmark(storage)).toEqual({ current: 'bm-current' });

    const read = await readDoPitrBookmark(storage, 1_700_000_000_000);
    expect(read).toEqual({ current: 'bm-current', forTime: 'bm-for-time' });
    expect(storage.forTimeCalls).toEqual([1_700_000_000_000]);
  });

  it('normalizes an ISO string and a numeric string time for the by-time lookup', async () => {
    const storage = new FakeSqliteStorage();
    await readDoPitrBookmark(storage, '2026-01-02T03:04:05.000Z');
    await readDoPitrBookmark(storage, '1500');
    expect(storage.forTimeCalls[0]).toBeInstanceOf(Date);
    expect(storage.forTimeCalls[1]).toBe(1500);
  });
});

describe('do-pitr — armDoPitr', () => {
  it('arms an explicit bookmark (bookmark wins over time) and returns the undo bookmark', async () => {
    const storage = new FakeSqliteStorage();
    const result = await armDoPitr(storage, { bookmark: 'bm-target', time: 999, restart: false });
    expect(result).toEqual({ restoredTo: 'bm-target', undoBookmark: 'bm-undo', restarted: false });
    expect(storage.armed).toEqual(['bm-target']); // time ignored — bookmark wins
    expect(storage.forTimeCalls).toEqual([]);
  });

  it('resolves a time target to a bookmark then arms it', async () => {
    const storage = new FakeSqliteStorage();
    const result = await armDoPitr(storage, { time: 1_700_000_000_000, restart: true });
    expect(result).toEqual({
      restoredTo: 'bm-for-time',
      undoBookmark: 'bm-undo',
      restarted: true,
    });
    expect(storage.armed).toEqual(['bm-for-time']);
  });

  it('never aborts — it only records the restart intent on the result', async () => {
    const storage = new FakeSqliteStorage();
    // A `restart: true` here must NOT throw or tear anything down — the RPC layer
    // owns the actual `ctx.abort()`. armDoPitr just reports the intent.
    const result = await armDoPitr(storage, { bookmark: 'bm-x', restart: true });
    expect(result.restarted).toBe(true);
  });
});

describe('do-pitr — non-SQLite / absent-API degradation', () => {
  const empty: DoPitrStorage = {};

  it('throws a typed PITR_UNAVAILABLE (409) error instead of "undefined is not a function"', async () => {
    await expect(readDoPitrBookmark(empty)).rejects.toBeInstanceOf(DoPitrUnavailableError);
    await expect(armDoPitr(empty, { bookmark: 'x' })).rejects.toBeInstanceOf(
      DoPitrUnavailableError,
    );

    const error = await readDoPitrBookmark(empty).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DoPitrUnavailableError);
    if (error instanceof DoPitrUnavailableError) {
      expect(error.code).toBe('PITR_UNAVAILABLE');
      expect(error.status).toBe(409);
    }
  });

  it('throws when only part of the API is present (current yes, by-time no)', async () => {
    const partial: DoPitrStorage = { getCurrentBookmark: () => Promise.resolve('bm') };
    // current-only read is fine...
    expect(await readDoPitrBookmark(partial)).toEqual({ current: 'bm' });
    // ...but a by-time read needs getBookmarkForTime.
    await expect(readDoPitrBookmark(partial, 1)).rejects.toBeInstanceOf(DoPitrUnavailableError);
  });

  it('a time target without a by-time resolver is unavailable', async () => {
    const armOnly: DoPitrStorage = {
      onNextSessionRestoreBookmark: (b) => Promise.resolve(`undo-${b}`),
    };
    await expect(armDoPitr(armOnly, { time: 1 })).rejects.toBeInstanceOf(DoPitrUnavailableError);
    // ...but a bookmark target only needs the arming method.
    expect(await armDoPitr(armOnly, { bookmark: 'bm' })).toMatchObject({ restoredTo: 'bm' });
  });

  it('requires a target (neither bookmark nor time → unavailable)', async () => {
    await expect(armDoPitr(new FakeSqliteStorage(), {})).rejects.toBeInstanceOf(
      DoPitrUnavailableError,
    );
  });
});

describe('do-pitr — isDoPitrUnavailable', () => {
  it('classifies the typed error, a name-only shape, and a message sentinel (RPC-hop safe)', () => {
    expect(isDoPitrUnavailable(new DoPitrUnavailableError())).toBe(true);
    // After an RPC hop, only name + message survive.
    expect(isDoPitrUnavailable({ name: 'DoPitrUnavailableError', message: 'x' })).toBe(true);
    expect(isDoPitrUnavailable({ message: 'PITR_UNAVAILABLE: gone' })).toBe(true);
    expect(isDoPitrUnavailable({ code: 'PITR_UNAVAILABLE' })).toBe(true);
    // Unrelated errors are not misclassified.
    expect(isDoPitrUnavailable(new Error('boom'))).toBe(false);
    expect(isDoPitrUnavailable(null)).toBe(false);
    expect(isDoPitrUnavailable('nope')).toBe(false);
  });
});
