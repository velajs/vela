import { COMMIT_CURSOR_HEADER, COMMIT_EPOCH_HEADER } from '@velajs/live-protocol';
import { getContext } from 'hono/context-storage';
import type {
  CommitStamp,
  InvalidationCommand,
  LiveDriver,
  LiveInvalidationSink,
} from './live.types';

/** Single-scope default driver: deliver straight to this process's engine. */
export function localLive(): LiveDriver {
  let sink: LiveInvalidationSink | undefined;
  return {
    kind: 'local',
    bind(s) {
      sink = s;
    },
    dispatch(cmd) {
      return sink?.applyInvalidation(cmd);
    },
  };
}

/**
 * Per-app wrapper around a (possibly SHARED) driver instance.
 *
 * A driver passed to `LiveModule.forRoot({ driver })` is a plain config object
 * — and on Cloudflare the SAME app module (thus the same driver object)
 * bootstraps in the Worker isolate AND inside each Durable Object, often
 * within one isolate. Mutable per-app state must therefore never live on the
 * driver itself: the DO flipping a shared `durableObjectLive()` into local
 * mode would otherwise poison the Worker's engine, which then executes the
 * DO's storage handle in the wrong request context ("Cannot perform I/O on
 * behalf of a different request").
 *
 * The wrapper owns the per-app sink and the per-app local-mode flag; isolate-
 * wide concerns (env capture) forward to the underlying driver. Platform init
 * hooks (`_setLocalMode`, `_initializeEnv`) are exposed pass-through so
 * platform packages can keep type-guarding on their presence.
 */
export function perAppLiveDriver(underlying: LiveDriver): LiveDriver {
  let ownSink: LiveInvalidationSink | undefined;
  let localMode = false;
  const cfHooks = underlying as Partial<{
    _setLocalMode(): void;
    _initializeEnv(env: Record<string, unknown>): void;
  }>;

  return {
    get kind() {
      return underlying.kind;
    },
    bind(sink) {
      ownSink = sink;
      underlying.bind(sink);
    },
    dispatch(cmd) {
      if (localMode && ownSink) return ownSink.applyInvalidation(cmd);
      return underlying.dispatch(cmd);
    },
    start: underlying.start ? () => underlying.start?.() : undefined,
    stop: underlying.stop ? () => underlying.stop?.() : undefined,
    // Platform hooks (Cloudflare): local mode is PER APP; env is per isolate.
    _setLocalMode() {
      localMode = true;
    },
    _initializeEnv(env: Record<string, unknown>) {
      cfHooks._initializeEnv?.(env);
    },
  } as LiveDriver;
}

/**
 * The injectable invalidation surface for custom (non-CRUD) write paths:
 *
 * ```ts
 * await this.live.invalidate({ tags: ['todos:' + listId] });
 * ```
 *
 * Every affected live query re-runs and pushes. Returns the commit stamp of
 * the targeted log scope so mutation endpoints can expose it to the client
 * (`Vela-Commit-Cursor` / `Vela-Commit-Epoch`) — the cursor optimistic
 * updates gate on. When ambient request access is enabled
 * (`VelaFactory.create(m, { ambientContainer: true })`) the headers are
 * stamped onto the current HTTP response automatically; otherwise stamp them
 * yourself via {@link stampCommitHeaders}.
 */
export class LiveInvalidation {
  constructor(private readonly driver: LiveDriver) {}

  async invalidate(cmd: InvalidationCommand): Promise<CommitStamp | undefined> {
    const stamp = await this.driver.dispatch(cmd);
    if (stamp) stampAmbientCommitHeaders(stamp);
    return stamp;
  }
}

/** Write the commit headers onto a Hono context (a mutation route's response). */
export function stampCommitHeaders(
  c: { header: (name: string, value: string) => unknown },
  stamp: CommitStamp,
): void {
  c.header(COMMIT_CURSOR_HEADER, String(stamp.cursor));
  c.header(COMMIT_EPOCH_HEADER, stamp.epoch);
}

/**
 * Best-effort automatic header stamping through Hono's ambient context
 * storage. A no-op outside a request or when `contextStorage()` isn't
 * registered — ALS keeps this per-request-correct under concurrency (a
 * mutable singleton slot would race interleaved awaits).
 */
function stampAmbientCommitHeaders(stamp: CommitStamp): void {
  try {
    stampCommitHeaders(getContext(), stamp);
  } catch {
    // Ambient access not enabled, or invalidate() ran outside a request
    // (queue job, cron tick) — there is no HTTP response to stamp.
  }
}
