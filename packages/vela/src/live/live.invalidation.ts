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
