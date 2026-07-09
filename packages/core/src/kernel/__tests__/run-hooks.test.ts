import { describe, it, expect, vi, afterEach } from 'vitest';

import { runHooks, runBeforeChain } from '../run-hooks';
import type { HookContext } from '../hook-types';

const ctx: HookContext = { db: { tx: undefined } };

/** Flush pending microtasks/macrotasks so fire-and-forget `.catch` handlers run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runHooks — sequential', () => {
  it('awaits hooks in order', async () => {
    const order: number[] = [];
    const mk = (n: number) => async () => {
      await flush();
      order.push(n);
    };
    await runHooks('sequential', [mk(1), mk(2), mk(3)], []);
    expect(order).toEqual([1, 2, 3]);
  });

  it('aborts and propagates on a throw (later hooks do not run)', async () => {
    const later = vi.fn();
    const boom = () => {
      throw new Error('stop');
    };
    await expect(runHooks('sequential', [boom, later], [])).rejects.toThrow('stop');
    expect(later).not.toHaveBeenCalled();
  });

  it('passes the args to each hook', async () => {
    const a = vi.fn();
    const b = vi.fn();
    await runHooks('sequential', [a, b], ['x', 42]);
    expect(a).toHaveBeenCalledWith('x', 42);
    expect(b).toHaveBeenCalledWith('x', 42);
  });
});

describe('runHooks — parallel', () => {
  it('runs all hooks concurrently and awaits them all', async () => {
    let running = 0;
    let maxConcurrent = 0;
    const mk = () => async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await flush();
      running--;
    };
    await runHooks('parallel', [mk(), mk(), mk()], []);
    expect(maxConcurrent).toBe(3);
  });

  it('rejects when any hook rejects (Promise.all semantics)', async () => {
    const ok = vi.fn(async () => {});
    const bad = async () => {
      throw new Error('parallel-fail');
    };
    await expect(runHooks('parallel', [ok, bad], [])).rejects.toThrow('parallel-fail');
    expect(ok).toHaveBeenCalled();
  });
});

describe('runHooks — fire-and-forget', () => {
  it('resolves immediately without awaiting a slow hook', async () => {
    let settled = false;
    const slow = () =>
      new Promise((resolve) => setTimeout(() => {
        settled = true;
        resolve(undefined);
      }, 1000));
    await runHooks('fire-and-forget', [slow], []);
    // Returned before the slow hook could settle.
    expect(settled).toBe(false);
  });

  it('swallows async rejections but warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rejecting = async () => {
      throw new Error('async-reject');
    };
    // Must NOT reject.
    await expect(runHooks('fire-and-forget', [rejecting], [])).resolves.toBeUndefined();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('swallows synchronous throws but warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwing = () => {
      throw new Error('sync-throw');
    };
    await expect(runHooks('fire-and-forget', [throwing], [])).resolves.toBeUndefined();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('runBeforeChain — sequential threads data', () => {
  it('replaces the payload with each hook return value', async () => {
    const add = (key: string, val: unknown) => (_c: HookContext, data: unknown) => ({
      ...(data as object),
      [key]: val,
    });
    const out = await runBeforeChain('sequential', [add('a', 1), add('b', 2)], ctx, { base: true });
    expect(out).toEqual({ base: true, a: 1, b: 2 });
  });

  it('keeps the current data when a hook returns undefined/void', async () => {
    const mutate = (_c: HookContext, data: unknown) => ({ ...(data as object), touched: true });
    const observe = () => undefined; // void hook must not wipe the data
    const out = await runBeforeChain('sequential', [mutate, observe], ctx, {});
    expect(out).toEqual({ touched: true });
  });

  it('feeds each hook the output of the previous one', async () => {
    const seen: unknown[] = [];
    const step = (n: number) => (_c: HookContext, data: unknown) => {
      seen.push(data);
      return { n };
    };
    await runBeforeChain('sequential', [step(1), step(2)], ctx, { start: true });
    expect(seen).toEqual([{ start: true }, { n: 1 }]);
  });

  it('aborts and propagates on a throw', async () => {
    const boom = () => {
      throw new Error('before-stop');
    };
    await expect(runBeforeChain('sequential', [boom], ctx, {})).rejects.toThrow('before-stop');
  });
});

describe('runBeforeChain — parallel IGNORES returns (locked parity)', () => {
  it('returns the original data even though hooks return replacements', async () => {
    const original = { original: true };
    const replace = () => ({ replaced: true });
    const out = await runBeforeChain('parallel', [replace, replace], ctx, original);
    expect(out).toBe(original); // same reference — no threading
  });

  it('still invokes every hook with the original data', async () => {
    const seen: unknown[] = [];
    const spy = (_c: HookContext, data: unknown) => {
      seen.push(data);
      return { mutated: true };
    };
    const original = { v: 0 };
    await runBeforeChain('parallel', [spy, spy], ctx, original);
    expect(seen).toEqual([original, original]);
  });

  it('rejects when any hook rejects', async () => {
    const bad = async () => {
      throw new Error('parallel-before-fail');
    };
    await expect(runBeforeChain('parallel', [bad], ctx, {})).rejects.toThrow('parallel-before-fail');
  });
});

describe('runBeforeChain — fire-and-forget', () => {
  it('returns the original data immediately and swallows failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const original = { x: 1 };
    const rejecting = async () => {
      throw new Error('faf-before');
    };
    const out = await runBeforeChain('fire-and-forget', [rejecting], ctx, original);
    expect(out).toBe(original);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('runHooks / runBeforeChain — empty hook lists', () => {
  it('runHooks resolves for no hooks', async () => {
    await expect(runHooks('sequential', [], [])).resolves.toBeUndefined();
    await expect(runHooks('parallel', [], [])).resolves.toBeUndefined();
    await expect(runHooks('fire-and-forget', [], [])).resolves.toBeUndefined();
  });

  it('runBeforeChain returns the data unchanged for no hooks', async () => {
    const data = { untouched: true };
    await expect(runBeforeChain('sequential', [], ctx, data)).resolves.toBe(data);
  });
});
