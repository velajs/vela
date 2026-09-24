import type { CfRoomRegistry } from './cf-room-registry';
import { LiveEngine, localLive, readPersistedLiveSubscriptions } from '@velajs/vela/live';
import type { CommitStamp, CursorLog, LivePlatform, ResumeVerdict } from '@velajs/vela/live';
import { CfWsClient } from './cf-ws-client';
import type { DoStateLike, SqlStorageLike } from './do-state';
import { CfLiveDriver, type LiveNamespace } from './live-driver';
import { roomToDurableId } from './room-id';

const DEFAULT_MAX_LOG_ROWS = 4096;

/**
 * The durable `CursorLog`: an append-only tag-invalidation log in the DO's
 * SQLite (`__vela_live_log`, AUTOINCREMENT seq = cursor) plus an epoch UUID in
 * `__vela_live_meta`. Because the cursor survives hibernation AND trims (it is
 * read from `sqlite_sequence`, lunora's `ctx-db-cdc.ts` trick), a reconnecting
 * client whose gap the log still covers gets a tiny `resume` instead of a
 * re-run — the real-resume half of the live protocol.
 *
 * The Cloudflare adapter gives `LiveModule` one inside every SQLite-backed
 * WebSocket Durable Object (wrangler: `new_sqlite_classes`); a class without
 * SQLite keeps an in-memory log. The Worker never consults a log: its
 * invalidations go to the room Durable Object, one log scope per room, exactly
 * the protocol's model.
 */
export class DoCursorLog implements CursorLog {
  private readonly epoch: string;

  constructor(
    private readonly sql: SqlStorageLike,
    private readonly maxRows = DEFAULT_MAX_LOG_ROWS,
  ) {
    sql.exec(
      'CREATE TABLE IF NOT EXISTS __vela_live_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, tags TEXT NOT NULL)',
    );
    sql.exec('CREATE TABLE IF NOT EXISTS __vela_live_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const row = sql.exec("SELECT v FROM __vela_live_meta WHERE k = 'epoch'").toArray()[0];
    if (row && typeof row.v === 'string') {
      this.epoch = row.v;
    } else {
      this.epoch = crypto.randomUUID();
      sql.exec("INSERT INTO __vela_live_meta (k, v) VALUES ('epoch', ?)", this.epoch);
    }
  }

  append(tags: string[]): CommitStamp {
    this.sql.exec(
      'INSERT INTO __vela_live_log (ts, tags) VALUES (?, ?)',
      Date.now(),
      JSON.stringify(tags),
    );
    const stamp = this.current();
    // Bounded retention: trimmed gaps degrade to snapshot-on-reconnect.
    if (stamp.cursor > this.maxRows) {
      this.sql.exec('DELETE FROM __vela_live_log WHERE seq <= ?', stamp.cursor - this.maxRows);
    }
    return stamp;
  }

  current(): CommitStamp {
    // sqlite_sequence survives DELETE-based trims, so the cursor never
    // rewinds. The table itself only materializes on the first AUTOINCREMENT
    // insert — before that the log is empty and the cursor is 0.
    let cursor = 0;
    try {
      const row = this.sql
        .exec("SELECT seq FROM sqlite_sequence WHERE name = '__vela_live_log'")
        .toArray()[0];
      cursor = typeof row?.seq === 'number' ? row.seq : Number(row?.seq ?? 0);
    } catch {
      cursor = 0;
    }
    return { cursor, epoch: this.epoch };
  }

  evaluateResume(
    sinceCursor: number,
    sinceEpoch: string,
    subscriptionTags: string[],
  ): ResumeVerdict {
    const { cursor, epoch } = this.current();
    if (sinceEpoch !== epoch) return 'snapshot'; // forked timeline (reset/recreated DO)
    if (sinceCursor > cursor) return 'snapshot'; // rollback guard
    if (sinceCursor === cursor) return 'resume';

    const minRow = this.sql.exec('SELECT MIN(seq) AS m FROM __vela_live_log').toArray()[0];
    const min = minRow?.m == null ? undefined : Number(minRow.m);
    // The log must still cover (sinceCursor, cursor] — a trimmed gap cannot be reasoned about.
    if (min === undefined || min > sinceCursor + 1) return 'snapshot';

    const subTags = new Set(subscriptionTags);
    for (const row of this.sql
      .exec('SELECT tags FROM __vela_live_log WHERE seq > ?', sinceCursor)
      .toArray()) {
      let tags: unknown;
      try {
        tags = JSON.parse(String(row.tags));
      } catch {
        return 'snapshot';
      }
      if (
        Array.isArray(tags) &&
        tags.some((tag: unknown) => typeof tag === 'string' && subTags.has(tag))
      )
        return 'rerun';
    }
    return 'resume';
  }
}

/**
 * The object's SQLite handle, or undefined when its class is not SQLite-backed.
 * workerd exposes `ctx.storage.sql` on every class; without SQLite (wrangler
 * `new_classes`) each statement throws, so probe with one.
 */
function sqliteStorage(ctx: DoStateLike): SqlStorageLike | undefined {
  try {
    const sql = ctx.storage?.sql;
    sql?.exec('SELECT 1');
    return sql;
  } catch {
    return undefined;
  }
}

/**
 * The live platform inside a WebSocket Durable Object: invalidations apply to
 * this object's own engine (a `durableObjectLive()` driver switches to local
 * delivery), and the cursor log lives in its SQLite storage when the class is
 * SQLite-backed, in memory otherwise (snapshot-on-reconnect after eviction).
 */
export function durableObjectLivePlatform(ctx: DoStateLike): LivePlatform {
  return {
    liveDriver: () => localLive(),
    cursorLog() {
      const sql = sqliteStorage(ctx);
      return sql ? new DoCursorLog(sql) : undefined;
    },
    bindDriver(driver) {
      if (driver instanceof CfLiveDriver) driver._setLocalMode();
    },
  };
}

/** The app-facing surface of the engine reached through `app.entrypoints.ofKind('live')`. */
interface EntrypointsApp {
  entrypoints: { ofKind(kind: string): Array<{ meta: unknown }> };
}

/**
 * DO-side wiring after lifecycle, called from `buildDoRuntime`: replay every hibernation-persisted
 * subscription into the (fresh) engine so an eviction is invisible to
 * subscribers. Returns the engine for the `invalidate` RPC, or undefined when
 * the app doesn't use LiveModule.
 */
export function initDoLive(
  app: EntrypointsApp,
  ctx: DoStateLike,
  registry?: CfRoomRegistry,
): LiveEngine | undefined {
  const entry = app.entrypoints.ofKind('live')[0];
  if (!entry) return undefined;
  if (typeof entry.meta !== 'object' || entry.meta === null || !('engine' in entry.meta)) {
    throw new Error('Invalid live entrypoint metadata.');
  }
  const engine = entry.meta.engine;
  if (!(engine instanceof LiveEngine)) throw new Error('Invalid live entrypoint engine.');

  // Wake-time replay: subscriptions ride the hibernation attachments.
  for (const ws of ctx.getWebSockets()) {
    const client = registry?.clientFor(ws) ?? new CfWsClient(ctx, ws);
    if (!client.id) continue;
    for (const record of readPersistedLiveSubscriptions(client)) {
      engine.restoreSubscription(client.path, client, record);
    }
  }

  return engine;
}

/**
 * Invalidate live tags in a room from a Worker (controller / cron / queue
 * consumer) through an explicit namespace. Returns the room log scope's
 * commit stamp for `Vela-Commit-Cursor` stamping.
 */
export async function liveInvalidateToRoom(
  ns: LiveNamespace,
  gatewayPath: string,
  room: string,
  tags: string[],
): Promise<CommitStamp | undefined> {
  const stub = ns.get(roomToDurableId(ns, gatewayPath, room));
  return stub.invalidate({ room, tags });
}
