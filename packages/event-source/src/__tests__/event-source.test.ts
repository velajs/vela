import { describe, expect, it, vi } from 'vitest';
import { EventLog, EventSource, type EventReducer } from '../index';

interface Counter extends Record<string, unknown> {
  total: number;
}

const counterReducer: EventReducer<Counter> = (state, entry) => {
  if (entry.type === 'add') return { total: state.total + (entry.payload as number) };
  return state;
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('EventSource replay', () => {
  it('folds a source log deterministically', () => {
    const source = new EventLog();
    source.commitAll([
      { type: 'add', payload: 5 },
      { type: 'add', payload: 3 },
    ]);
    const es = new EventSource<Counter>({ total: 0 }, counterReducer);
    es.replayFrom(source);
    expect(es.state.total).toBe(8);
    expect(es.replayed).toBe(true);
    // Deterministic: a fresh runtime over the same source reaches the same state.
    const twin = new EventSource<Counter>({ total: 0 }, counterReducer);
    twin.replayFrom(source);
    expect(twin.state.total).toBe(8);
  });

  it('advances a source watermark so a repeated replay only applies new entries', () => {
    const source = new EventLog();
    source.append({ type: 'add', payload: 1 });
    const applied = vi.fn(counterReducer);
    const es = new EventSource<Counter>({ total: 0 }, applied);
    es.replayFrom(source);
    expect(es.sourceWatermark).toBe(0);
    source.append({ type: 'add', payload: 10 });
    es.replayFrom(source);
    expect(es.state.total).toBe(11);
    // Reducer saw each source entry exactly once across both replays.
    expect(applied).toHaveBeenCalledTimes(2);
  });

  it('applyEvent appends to the runtime log and updates state', () => {
    const es = new EventSource<Counter>({ total: 0 }, counterReducer);
    const entry = es.applyEvent({ type: 'add', payload: 2 });
    expect(entry.seq).toBe(0);
    expect(es.state.total).toBe(2);
    expect(es.log.size).toBe(1);
  });
});

describe('EventSource reset / resume', () => {
  it('resumes from a snapshot watermark without reprocessing prior entries', () => {
    const source = new EventLog();
    source.commitAll([
      { type: 'add', payload: 1 },
      { type: 'add', payload: 2 },
    ]);
    const first = new EventSource<Counter>({ total: 0 }, counterReducer);
    first.replayFrom(source);
    expect(first.state.total).toBe(3);

    // Restart: seed with the snapshot state + its watermark; only later events apply.
    source.append({ type: 'add', payload: 4 });
    const resumed = new EventSource<Counter>({ total: 0 }, counterReducer);
    resumed.reset({ total: 3 }, first.sourceWatermark, first.sourceEpoch);
    resumed.replayFrom(source);
    expect(resumed.state.total).toBe(7); // 3 (snapshot) + 4, NOT 3 + 1 + 2 + 4
  });

  it('a default reset replays everything', () => {
    const source = new EventLog();
    source.append({ type: 'add', payload: 9 });
    const es = new EventSource<Counter>({ total: 0 }, counterReducer);
    es.reset({ total: 0 });
    expect(es.replayed).toBe(false);
    es.replayFrom(source);
    expect(es.state.total).toBe(9);
  });
});

describe('EventSource unknown-event handling', () => {
  it('fails closed by default without committing the unknown event', () => {
    const es = new EventSource<Counter>({ total: 0 }, counterReducer);
    expect(() => es.applyEvent({ type: 'mystery', payload: 1 })).toThrow(/unhandled event type/);
    expect(es.state.total).toBe(0);
    expect(es.log.size).toBe(0);
    expect(es.log.nextSeq).toBe(0);
  });

  it('warn skips only when explicitly configured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const es = new EventSource<Counter>({ total: 0 }, counterReducer, {
      unknownEventHandling: 'warn',
    });
    es.applyEvent({ type: 'mystery', payload: 1 });
    expect(es.state.total).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('ignore skips silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const es = new EventSource<Counter>({ total: 0 }, counterReducer, {
      unknownEventHandling: 'ignore',
    });
    es.applyEvent({ type: 'mystery', payload: 1 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fail throws on an unhandled event', () => {
    const es = new EventSource<Counter>({ total: 0 }, counterReducer, {
      unknownEventHandling: 'fail',
    });
    expect(() => es.applyEvent({ type: 'mystery', payload: 1 })).toThrow(/unhandled event type/);
  });

  it('a callback can claim an unhandled event', () => {
    const seen: string[] = [];
    const es = new EventSource<Counter>({ total: 0 }, counterReducer, {
      unknownEventHandling: (entry) => {
        seen.push(entry.type);
        return true;
      },
    });
    const stateChanged = vi.fn();
    es.emitter.on('state-changed', stateChanged);
    es.applyEvent({ type: 'mystery', payload: 1 });
    expect(seen).toEqual(['mystery']);
    // Claimed events still emit state-changed so consumers know they ran.
    expect(stateChanged).toHaveBeenCalledOnce();
  });
});

describe('EventSource replay errors', () => {
  it('applyEvent leaves no committed poison entry when the reducer throws', () => {
    const es = new EventSource<Counter>({ total: 0 }, () => {
      throw new Error('poison');
    });
    expect(() => es.applyEvent({ type: 'add', payload: 1 })).toThrow('poison');
    expect(es.log.size).toBe(0);
    expect(es.log.nextSeq).toBe(0);
    expect(es.state.total).toBe(0);
  });

  it('emits replay-error and stops at the poisoned entry without advancing', () => {
    const source = new EventLog();
    source.commitAll([
      { type: 'add', payload: 1 },
      { type: 'boom', payload: 0 },
      { type: 'add', payload: 2 },
    ]);
    const reducer: EventReducer<Counter> = (state, entry) => {
      if (entry.type === 'boom') throw new Error('kaboom');
      return counterReducer(state, entry);
    };
    const es = new EventSource<Counter>({ total: 0 }, reducer);
    const errors: string[] = [];
    es.emitter.on('replay-error', ({ error }) => errors.push(error.message));
    expect(() => es.replayFrom(source)).toThrow('kaboom');
    expect(errors).toEqual(['kaboom']);
    expect(es.state.total).toBe(1);
    expect(es.sourceWatermark).toBe(0);
  });
});

describe('EventSource at-least-once discipline', () => {
  it('redelivers events to a cold restart, so side effects must be idempotent', () => {
    const source = new EventLog();
    source.append({ type: 'add', payload: 10 });

    let externalSideEffect = 0;
    const reducer: EventReducer<Counter> = (state, entry) => {
      if (entry.type !== 'add') return state;
      const amount = entry.payload as number;
      externalSideEffect += amount; // NON-idempotent side effect (the footgun)
      return { total: state.total + amount };
    };

    // Session A applies, then "crashes" before persisting its watermark.
    const sessionA = new EventSource<Counter>({ total: 0 }, reducer);
    sessionA.replayFrom(source);
    expect(externalSideEffect).toBe(10);

    // Session B starts cold (watermark lost) and replays the same source.
    const sessionB = new EventSource<Counter>({ total: 0 }, reducer);
    sessionB.replayFrom(source);

    // The side effect ran twice — delivery is at-least-once.
    expect(externalSideEffect).toBe(20);
    // But the pure derived state is correct in each session (recompute-safe).
    expect(sessionA.state.total).toBe(10);
    expect(sessionB.state.total).toBe(10);
  });
});

describe('EventSource events stream', () => {
  it('drains applied entries then streams future ones until aborted', async () => {
    const es = new EventSource<Counter>({ total: 0 }, counterReducer);
    es.applyEvent({ type: 'add', payload: 1 });

    const controller = new AbortController();
    const seen: number[] = [];
    const iterate = (async () => {
      for await (const entry of es.events(controller.signal)) {
        seen.push(entry.payload as number);
        if (seen.length === 2) controller.abort();
      }
    })();

    await tick(); // let phase 1 drain the already-applied entry
    es.applyEvent({ type: 'add', payload: 2 });
    await iterate;

    expect(seen).toEqual([1, 2]);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const es = new EventSource<Counter>({ total: 0 }, counterReducer);
    es.applyEvent({ type: 'add', payload: 1 });
    const controller = new AbortController();
    controller.abort();
    const seen: number[] = [];
    for await (const entry of es.events(controller.signal)) seen.push(entry.seq);
    expect(seen).toEqual([]);
  });
});
