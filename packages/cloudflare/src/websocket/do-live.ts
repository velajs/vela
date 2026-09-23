import type { CfRoomRegistry } from './cf-room-registry';
import type { Container } from '@velajs/vela';
import {
  LIVE_CURSOR_LOG,
  LIVE_DRIVER,
  LiveEngine,
  readPersistedLiveSubscriptions,
} from '@velajs/vela/live';
import type {
  CommitStamp,
  CursorLog,
  InvalidationCommand,
  LiveDriver,
  LiveInvalidationSink,
  ResumeVerdict,
} from '@velajs/vela/live';
import { CfWsClient } from './cf-ws-client';
import type { DoStateLike, SqlStorageLike } from './do-state';
import { roomToDurableId } from './room-id';

const DEFAULT_ROOM = 'default';
const DEFAULT_MAX_LOG_ROWS = 4096;

/**
 * The durable `CursorLog`: an append-only tag-invalidation log in the DO's
 * SQLite (`__vela_live_log`, AUTOINCREMENT seq = cursor) plus an epoch UUID in
 * `__vela_live_meta`. Because the cursor survives hibernation AND trims (it is
 * read from `sqlite_sequence`, lunora's `ctx-db-cdc.ts` trick), a reconnecting
 * client whose gap the log still covers gets a tiny `resume` instead of a
 * re-run — the real-resume half of the live protocol.
 *
 * Constructed un-initialized at module-composition time (the same app module
 * bootstraps in the Worker AND in each DO); `initDoLive` wires the SQLite
 * handle inside the DO. In the Worker isolate it stays un-initialized — and is
 * never consulted there, because `durableObjectLive()` routes every
 * invalidation to the room DO's log (one log scope per room, exactly the
 * protocol's model).
 */
export class DoCursorLog implements CursorLog {
  private sql?: SqlStorageLike;
  private epoch?: string;

  constructor(private readonly maxRows = DEFAULT_MAX_LOG_ROWS) {}

  /** @internal — called by `initDoLive` with the DO's `ctx.storage.sql`. */
  _initialize(sql: SqlStorageLike): void {
    this.sql = sql;
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
    const sql = this.assertReady();
    sql.exec(
      'INSERT INTO __vela_live_log (ts, tags) VALUES (?, ?)',
      Date.now(),
      JSON.stringify(tags),
    );
    const stamp = this.current();
    // Bounded retention: trimmed gaps degrade to snapshot-on-reconnect.
    if (stamp.cursor > this.maxRows) {
      sql.exec('DELETE FROM __vela_live_log WHERE seq <= ?', stamp.cursor - this.maxRows);
    }
    return stamp;
  }

  current(): CommitStamp {
    const sql = this.assertReady();
    // sqlite_sequence survives DELETE-based trims, so the cursor never
    // rewinds. The table itself only materializes on the first AUTOINCREMENT
    // insert — before that the log is empty and the cursor is 0.
    let cursor = 0;
    try {
      const row = sql
        .exec("SELECT seq FROM sqlite_sequence WHERE name = '__vela_live_log'")
        .toArray()[0];
      cursor = typeof row?.seq === 'number' ? row.seq : Number(row?.seq ?? 0);
    } catch {
      cursor = 0;
    }
    if (!this.epoch) throw new Error('DoCursorLog epoch is not initialized.');
    return { cursor, epoch: this.epoch };
  }

  evaluateResume(
    sinceCursor: number,
    sinceEpoch: string,
    subscriptionTags: string[],
  ): ResumeVerdict {
    const sql = this.assertReady();
    const { cursor, epoch } = this.current();
    if (sinceEpoch !== epoch) return 'snapshot'; // forked timeline (reset/recreated DO)
    if (sinceCursor > cursor) return 'snapshot'; // rollback guard
    if (sinceCursor === cursor) return 'resume';

    const minRow = sql.exec('SELECT MIN(seq) AS m FROM __vela_live_log').toArray()[0];
    const min = minRow?.m == null ? undefined : Number(minRow.m);
    // The log must still cover (sinceCursor, cursor] — a trimmed gap cannot be reasoned about.
    if (min === undefined || min > sinceCursor + 1) return 'snapshot';

    const subTags = new Set(subscriptionTags);
    for (const row of sql
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

  private assertReady(): SqlStorageLike {
    if (!this.sql) {
      throw new Error(
        'DoCursorLog is not initialized. It only runs inside a SQLite-backed Durable Object ' +
          '(wrangler: new_sqlite_classes) — Worker-side invalidations must go through durableObjectLive(), ' +
          "which routes them to the room DO's log.",
      );
    }
    return this.sql;
  }
}

export interface DurableObjectLiveOptions {
  /** Native, RPC-typed namespace supplied by the application's environment. */
  namespace: LiveNamespace;
  /** Exact `@WebSocketGateway()` path sharing this room/log namespace. */
  gatewayPath: string;
  /** Room used when an invalidation names none. Matches the client default. */
  defaultRoom?: string;
}

export interface LiveInvalidateStub {
  invalidate(cmd: InvalidationCommand): Promise<CommitStamp | undefined>;
}

/** Only the native namespace operations required for live invalidation. */
export interface LiveNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): LiveInvalidateStub;
}

/** One driver per application; construct from a LiveModule driver factory. */
export class CfLiveDriver implements LiveDriver {
  readonly kind = 'durable-object';
  private sink: LiveInvalidationSink | undefined;
  private localMode = false;

  constructor(private readonly options: DurableObjectLiveOptions) {}

  bind(sink: LiveInvalidationSink): void {
    this.sink = sink;
  }

  /** @internal — a DO dispatches to its own engine and SQLite log. */
  _setLocalMode(): void {
    this.localMode = true;
  }

  dispatch(cmd: InvalidationCommand): Promise<CommitStamp | undefined> | CommitStamp | undefined {
    if (this.localMode) return this.sink?.applyInvalidation(cmd);
    const { namespace, gatewayPath, defaultRoom } = this.options;
    const room = cmd.room ?? defaultRoom ?? DEFAULT_ROOM;
    return namespace
      .get(roomToDurableId(namespace, gatewayPath, room))
      .invalidate({ ...cmd, room });
  }
}

/** Use in LiveModule.forRootAsync: driver: () => durableObjectLive({ namespace: env.ROOMS, ... }). */
export function durableObjectLive(options: DurableObjectLiveOptions): CfLiveDriver {
  return new CfLiveDriver(options);
}

/** The app-facing surface of the engine reached through `app.entrypoints.ofKind('live')`. */
interface EntrypointsApp {
  entrypoints: { ofKind(kind: string): Array<{ meta: unknown }> };
}

/** @internal — prepare per-DO resources before user lifecycle hooks can invalidate. */
export function initializeDoLiveResources(container: Container, ctx: DoStateLike): void {
  if (container.has(LIVE_CURSOR_LOG)) {
    const log = container.resolve(LIVE_CURSOR_LOG);
    if (log instanceof DoCursorLog) {
      const sql = ctx.storage?.sql;
      if (!sql) {
        throw new Error(
          'DoCursorLog requires a SQLite-backed Durable Object: add this class to ' +
            "wrangler's `migrations[].new_sqlite_classes`. Falling back is not possible — " +
            'either enable SQLite or drop the `log: () => durableObjectCursorLog()` option ' +
            '(snapshot-on-reconnect semantics).',
        );
      }
      log._initialize(sql);
    }
  }

  if (container.has(LIVE_DRIVER)) {
    const driver = container.resolve(LIVE_DRIVER);
    if (driver instanceof CfLiveDriver) driver._setLocalMode();
  }
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

let workerLocalLiveWarned = false;

/**
 * @internal Worker-isolate check, warned once per isolate. `localLive()` hands
 * invalidations to this isolate's own engine, but subscriptions are held by
 * the WebSocket Durable Object, so Worker-side writes would never reach them.
 */
export async function warnWorkerLocalLive(container: Container): Promise<void> {
  if (workerLocalLiveWarned || container.getDiagnostics() === 'silent') return;
  if (!container.has(LIVE_DRIVER)) return;
  const driver = await container.resolveAsync(LIVE_DRIVER);
  if (driver.kind !== 'local') return;
  workerLocalLiveWarned = true;
  console.warn(
    '[vela] LiveModule is running localLive() in the Worker isolate: its subscriptions live in ' +
      'the WebSocket Durable Object, so invalidations sent from the Worker never reach them. ' +
      'Pass driver: () => durableObjectLive({ namespace, gatewayPath }) to LiveModule.',
  );
}

/** Ergonomic alias: the log option for `LiveModule.forRoot` on Cloudflare. */
export function durableObjectCursorLog(maxRows?: number): DoCursorLog {
  return new DoCursorLog(maxRows);
}

/**
 * Invalidate live tags in a room from a Worker (controller / cron / queue
 * consumer) — the live sibling of `broadcastToRoom`. Returns the room log
 * scope's commit stamp for `Vela-Commit-Cursor` stamping.
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
