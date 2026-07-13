/**
 * The hook executor for the native CRUD kernel.
 *
 * Two entry points:
 *   - {@link runHooks} — fan a group of same-phase hooks over fixed `args`
 *     under a {@link HookMode}. Used for after-hooks and observe-only
 *     before-hooks whose return value is not threaded.
 *   - {@link runBeforeChain} — run a group of before-hooks that can REPLACE the
 *     data flowing into the write. In `sequential` mode each returned value
 *     becomes the input to the next hook (and the final result); `parallel`
 *     and `fire-and-forget` IGNORE returned values (they cannot thread), a
 *     parity rule locked by tests.
 */

import type { HookContext, HookMode } from './hook-types';

/** Any hook. `never[]` params let a heterogeneously-typed hook array unify. */
type AnyHookFn = (...args: never[]) => unknown;

/** A before-hook: `(ctx, data) => maybe-replacement`. */
type BeforeHookFn = (ctx: HookContext, data: unknown) => unknown;

/**
 * Report a swallowed `fire-and-forget` hook failure without letting it affect
 * the request. Both synchronous throws and async rejections route here.
 */
function warnSwallowed(error: unknown): void {
  console.warn('[crud] fire-and-forget hook failed (swallowed):', error);
}

/**
 * Invoke a hook in `fire-and-forget` fashion: do not await it, and swallow both
 * a synchronous throw and an async rejection (warning on each). Returns
 * immediately.
 */
function invokeFireAndForget(fn: AnyHookFn, args: unknown[]): void {
  try {
    const result = (fn as (...a: unknown[]) => unknown)(...args);
    if (result instanceof Promise) {
      result.catch(warnSwallowed);
    }
  } catch (error) {
    warnSwallowed(error);
  }
}

/**
 * Run `fns` over `args` under `mode`:
 *   - `sequential` — `await` each in order; a throw aborts and propagates.
 *   - `parallel` — start all, `await Promise.all`; the first rejection aborts.
 *   - `fire-and-forget` — invoke each without awaiting; rejections/throws are
 *     swallowed (and warned). Resolves immediately regardless of the hooks.
 *
 * Return values are discarded — use {@link runBeforeChain} to thread data.
 */
export async function runHooks(mode: HookMode, fns: AnyHookFn[], args: unknown[]): Promise<void> {
  if (fns.length === 0) return;

  switch (mode) {
    case 'sequential': {
      for (const fn of fns) {
        await (fn as (...a: unknown[]) => unknown)(...args);
      }
      return;
    }
    case 'parallel': {
      await Promise.all(fns.map((fn) => (fn as (...a: unknown[]) => unknown)(...args)));
      return;
    }
    case 'fire-and-forget': {
      for (const fn of fns) invokeFireAndForget(fn, args);
      return;
    }
  }
}

/**
 * Run a chain of before-hooks that may replace the in-flight `data`.
 *
 *   - `sequential` — each hook receives the CURRENT data; a returned value
 *     (non-`undefined`) replaces it for the next hook. A hook returning
 *     `undefined`/`void` leaves the data unchanged. The final data is returned.
 *     A throw aborts and propagates.
 *   - `parallel` — every hook receives the ORIGINAL data concurrently; returned
 *     values are IGNORED (you cannot thread through concurrent hooks). Resolves
 *     to the original data. The first rejection aborts.
 *   - `fire-and-forget` — hooks are invoked without awaiting; returns the
 *     original data immediately and swallows failures.
 *
 * Mirrors hono-crud's before-hook semantics (a single sequential before-hook
 * whose return value replaces the payload) generalised to N hooks, and pins
 * the "parallel ignores returns" rule the way hono-crud treats concurrent
 * before-hooks.
 */
export async function runBeforeChain(
  mode: HookMode,
  fns: BeforeHookFn[],
  ctx: HookContext,
  data: unknown,
): Promise<unknown> {
  if (fns.length === 0) return data;

  switch (mode) {
    case 'sequential': {
      let current = data;
      for (const fn of fns) {
        const result = await fn(ctx, current);
        if (result !== undefined) current = result;
      }
      return current;
    }
    case 'parallel': {
      // Returned values are intentionally discarded — concurrent hooks cannot
      // thread a shared payload. All observe the original `data`.
      await Promise.all(fns.map((fn) => fn(ctx, data)));
      return data;
    }
    case 'fire-and-forget': {
      for (const fn of fns) {
        invokeFireAndForget(fn as AnyHookFn, [ctx, data]);
      }
      return data;
    }
  }
}
