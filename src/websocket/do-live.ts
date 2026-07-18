import type { Container } from '@velajs/vela';
import { LIVE_CURSOR_LOG, LIVE_DRIVER, readPersistedLiveSubscriptions } from '@velajs/vela/live';
import type {
  CommitStamp,
  CursorLog,
  InvalidationCommand,
  LiveDriver,
  LiveEngine,
  LiveEntrypointMeta,
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
    return { cursor, epoch: this.epoch as string };
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
      if (Array.isArray(tags) && tags.some((tag) => subTags.has(tag as string))) return 'rerun';
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
  /** The wrangler binding name of the WebSocket DO namespace (e.g. `'CHAT_ROOM'`). */
  binding: string;
  /** Exact `@WebSocketGateway()` path sharing this room/log namespace. */
  gatewayPath: string;
  /** Room used when an invalidation names none. Matches the client default. */
  defaultRoom?: string;
}

interface LiveInvalidateStub {
  invalidate(cmd: InvalidationCommand): Promise<CommitStamp | undefined>;
}

export interface CfLiveDriver extends LiveDriver {
  /** @internal — Worker isolate: capture `env` so the namespace binding resolves per dispatch. */
  _initializeEnv(env: Record<string, unknown>): void;
  /** @internal — DO isolate: deliver invalidations straight to this DO's engine. */
  _setLocalMode(): void;
}

/**
 * The Cloudflare `LiveDriver`. Dual-mode, because the SAME app module
 * bootstraps in both isolates:
 *
 * - **Worker** (HTTP mutations, queue consumers, crons): route the command to
 *   the room's Durable Object over the `invalidate` RPC — the same canonical
 *   `roomToDurableId` mapping the upgrade route and `broadcastToRoom` use —
 *   and return THAT log scope's commit stamp (what `Vela-Commit-Cursor`
 *   must carry).
 * - **DO** (writes issued from inside the object): apply to the local engine.
 */
export function durableObjectLive(options: DurableObjectLiveOptions): CfLiveDriver {
  let sink: LiveInvalidationSink | undefined;
  let env: Record<string, unknown> | undefined;
  let localMode = false;

  return {
    kind: 'durable-object',
    bind(boundSink) {
      sink = boundSink;
    },
    _initializeEnv(capturedEnv) {
      env = capturedEnv;
    },
    _setLocalMode() {
      localMode = true;
    },
    dispatch(cmd) {
      if (localMode) return sink?.applyInvalidation(cmd);
      const namespace = env?.[options.binding] as DurableObjectNamespace | undefined;
      if (!namespace) {
        throw new Error(
          `durableObjectLive: binding '${options.binding}' is not available. In a Worker, ` +
            'createCloudflareApp() captures env on the first request; check the wrangler binding name.',
        );
      }
      const room = cmd.room ?? options.defaultRoom ?? DEFAULT_ROOM;
      const stub = namespace.get(
        roomToDurableId(namespace, options.gatewayPath, room),
      ) as unknown as LiveInvalidateStub;
      return stub.invalidate({ ...cmd, room });
    },
  };
}

const isCfLiveDriver = (value: unknown): value is CfLiveDriver =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as CfLiveDriver)._setLocalMode === 'function' &&
  typeof (value as CfLiveDriver)._initializeEnv === 'function';

/** Worker-side wiring, called from `cloudflareAdapter`'s first-request middleware. */
export function initializeWorkerLive(container: Container, env: Record<string, unknown>): void {
  let driver: unknown;
  try {
    driver = container.resolve(LIVE_DRIVER);
  } catch {
    return; // LiveModule not imported
  }
  if (isCfLiveDriver(driver)) driver._initializeEnv(env);
}

/** The app-facing surface of the engine reached through `app.entrypoints.ofKind('live')`. */
interface EntrypointsApp {
  entrypoints: { ofKind<M>(kind: string): Array<{ meta: M }> };
}

/**
 * DO-side wiring, called from `buildDoRuntime`: initialize the SQLite cursor
 * log, flip the driver to local mode, and replay every hibernation-persisted
 * subscription into the (fresh) engine so an eviction is invisible to
 * subscribers. Returns the engine for the `invalidate` RPC, or undefined when
 * the app doesn't use LiveModule.
 */
export function initDoLive(
  app: EntrypointsApp,
  container: Container,
  ctx: DoStateLike,
): LiveEngine | undefined {
  const entry = app.entrypoints.ofKind<LiveEntrypointMeta>('live')[0];
  if (!entry) return undefined;
  const engine = entry.meta.engine as LiveEngine;

  try {
    const log = container.resolve(LIVE_CURSOR_LOG);
    if (log instanceof DoCursorLog) {
      const sql = ctx.storage?.sql;
      if (!sql) {
        throw new Error(
          'DoCursorLog requires a SQLite-backed Durable Object: add this class to ' +
            "wrangler's `migrations[].new_sqlite_classes`. Falling back is not possible — " +
            'either enable SQLite or drop the `log: durableObjectCursorLog()` option ' +
            '(snapshot-on-reconnect semantics).',
        );
      }
      log._initialize(sql);
    }
  } catch (err) {
    // Surface misconfiguration loudly — a silently un-initialized log would
    // throw on the first subscribe instead.
    if (err instanceof Error && err.message.includes('new_sqlite_classes')) throw err;
  }

  try {
    const driver = container.resolve(LIVE_DRIVER);
    if (isCfLiveDriver(driver)) driver._setLocalMode();
  } catch {
    // LiveModule always provides LIVE_DRIVER when the engine exists; defensive only.
  }

  // Wake-time replay: subscriptions ride the hibernation attachments.
  for (const ws of ctx.getWebSockets()) {
    const client = new CfWsClient(ctx, ws);
    for (const record of readPersistedLiveSubscriptions(client)) {
      engine.restoreSubscription(client.path, client, record);
    }
  }

  return engine;
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
  ns: DurableObjectNamespace,
  gatewayPath: string,
  room: string,
  tags: string[],
): Promise<CommitStamp | undefined> {
  const stub = ns.get(roomToDurableId(ns, gatewayPath, room)) as unknown as LiveInvalidateStub;
  return stub.invalidate({ room, tags });
}
