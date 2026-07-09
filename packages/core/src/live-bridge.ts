/**
 * The `live: true` bridge — tag-based live-query invalidation for CRUD
 * resources (`@velajs/vela/live`).
 *
 * After a successful write verb the bridge invalidates `crud:<tableName>`
 * (plus any configured extra tags) and merges the commit-cursor headers into
 * the outgoing `EngineResult`. The seam is the synthesized handler's
 * result boundary: `resource.execute()` has returned — so the write
 * transaction is committed (a rollback must never broadcast) — but
 * `toResponse` hasn't flushed yet, so headers still apply. Non-2xx results
 * invalidate nothing.
 *
 * `@Override` handlers bypass the bridge (they own their responses); they can
 * inject `LiveInvalidation` and stamp manually — see PARITY.md.
 */

import type { Context } from 'hono';
import { getRequestContainer } from '@velajs/vela';
import { LiveInvalidation, stampCommitHeaders } from '@velajs/vela/live';
import type { EngineResult } from './kernel/engine-request';
import type { CrudConfig, CrudLiveConfig } from './crud.types';

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

const warnedMissingLive = new Set<string>();

/** The invalidation tag a live CRUD resource emits: matches `@LiveQuery({ tags: ['crud:<table>'] })`. */
export const crudLiveTag = (tableName: string): string => `crud:${tableName}`;

export type LiveStamper = (c: Context, result: EngineResult, method: string) => Promise<void>;

/**
 * Builds the per-class live stamper, or `undefined` when the resource is not
 * live. Resolution of `LiveInvalidation` is lazy and per-request (via the
 * request child container) and degrades to a one-time warning when
 * `LiveModule` isn't imported — live is an enhancement, never a crash.
 */
export function buildLiveStamper(config: CrudConfig): LiveStamper | undefined {
  if (!config.live) return undefined;

  const tableName = config.model.tableName;
  const live: CrudLiveConfig = typeof config.live === 'object' ? config.live : {};
  const baseTag = crudLiveTag(tableName);

  return async (c, result, method) => {
    if (!WRITE_METHODS.has(method.toLowerCase())) return;
    if (result.status < 200 || result.status >= 300) return;

    const invalidation = resolveInvalidation(c, tableName);
    if (!invalidation) return;

    const tags = [baseTag, ...(live.tags?.(c) ?? [])];
    const stamp = await invalidation.invalidate({ tags, room: live.room?.(c) });
    if (stamp) {
      const headers: Record<string, string> = { ...(result.headers ?? {}) };
      stampCommitHeaders({ header: (name, value) => (headers[name] = value) }, stamp);
      result.headers = headers;
    }
  };
}

function resolveInvalidation(c: Context, tableName: string): LiveInvalidation | undefined {
  try {
    const resolved = getRequestContainer(c).resolve(LiveInvalidation);
    // Duck-typed on purpose: a second physical copy of @velajs/vela (HMR,
    // test overrides via useValue) must not defeat live invalidation the way
    // an `instanceof` check would.
    if (resolved && typeof (resolved as LiveInvalidation).invalidate === 'function') {
      return resolved as LiveInvalidation;
    }
  } catch {
    // fall through to the warning below
  }
  if (!warnedMissingLive.has(tableName)) {
    warnedMissingLive.add(tableName);
    console.warn(
      `[vela] @Crud resource '${tableName}' is marked live: true but LiveInvalidation is not ` +
        'resolvable — did you import LiveModule.forRoot()? Live invalidation is disabled for it.',
    );
  }
  return undefined;
}
