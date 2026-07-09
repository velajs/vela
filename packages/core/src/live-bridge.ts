import type { Context, MiddlewareHandler } from 'hono';
import type { Container } from '@velajs/vela';
import { LiveInvalidation, stampCommitHeaders } from '@velajs/vela/live';
import type { CrudConfig, CrudLiveConfig } from './types';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const warnedMissingLive = new Set<string>();

/** The invalidation tag a live CRUD resource emits: matches `@LiveQuery({ tags: ['crud:<table>'] })`. */
export const crudLiveTag = (tableName: string): string => `crud:${tableName}`;

/**
 * The `live: true` bridge — a response-boundary middleware on the CRUD
 * sub-app. After a successful write verb it invalidates `crud:<tableName>`
 * (plus any configured extra tags) and stamps the commit-cursor headers onto
 * the outgoing response.
 *
 * Timing rationale: `await next()` returns once the generated handler — and
 * the write transaction inside it — has completed, but BEFORE the response is
 * flushed. That is the only point that is simultaneously post-commit (a
 * rollback must not broadcast; hono-crud's flat `afterX` hooks fire inside
 * the transaction) and pre-flush (hono-crud's own event emitter dispatches
 * after the response, too late for headers). Non-2xx responses invalidate
 * nothing.
 */
export function buildLiveBridgeMiddleware(
  crudConfig: CrudConfig,
  container: Container | undefined,
): MiddlewareHandler | undefined {
  if (!crudConfig.live) return undefined;

  const tableName = (crudConfig.meta as { model?: { tableName?: string } } | undefined)?.model
    ?.tableName;
  if (typeof tableName !== 'string' || tableName.length === 0) {
    throw new Error(
      "@velajs/crud: 'live' requires a model with a tableName (the invalidation tag is derived from it).",
    );
  }
  const live: CrudLiveConfig = typeof crudConfig.live === 'object' ? crudConfig.live : {};
  const baseTag = crudLiveTag(tableName);

  // Lazily resolved once: the contributor builds routes before every module's
  // providers are guaranteed constructed, and apps without LiveModule should
  // degrade to a warning, not a crash.
  let invalidation: LiveInvalidation | undefined | null = null;

  return async (c: Context, next) => {
    await next();
    if (!WRITE_METHODS.has(c.req.method)) return;
    if (c.res.status < 200 || c.res.status >= 300) return;

    if (invalidation === null) {
      invalidation = resolveInvalidation(container, tableName);
    }
    if (!invalidation) return;

    const tags = [baseTag, ...(live.tags?.(c) ?? [])];
    const stamp = await invalidation.invalidate({ tags, room: live.room?.(c) });
    if (stamp) {
      // Mutate the finalized response's headers directly — header state set
      // via c.header() before next() is already consumed at this point.
      stampCommitHeaders({ header: (name, value) => c.res.headers.set(name, value) }, stamp);
    }
  };
}

function resolveInvalidation(
  container: Container | undefined,
  tableName: string,
): LiveInvalidation | undefined {
  try {
    const resolved = container?.resolve(LiveInvalidation);
    if (resolved instanceof LiveInvalidation) return resolved;
  } catch {
    // fall through to the warning below
  }
  if (!warnedMissingLive.has(tableName)) {
    warnedMissingLive.add(tableName);
    // crud's tsconfig carries no DOM lib; console exists on every target runtime.
    (globalThis as { console?: { warn(message: string): void } }).console?.warn(
      `[vela] @Crud resource '${tableName}' is marked live: true but LiveInvalidation is not ` +
        'resolvable — did you import LiveModule.forRoot()? Live invalidation is disabled for it.',
    );
  }
  return undefined;
}
