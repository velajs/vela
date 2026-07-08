import {
  LIVE_ERROR_CODES,
  LIVE_PROTOCOL,
  encodeLiveEnvelope,
  isClientLiveFrame,
} from '@velajs/live-protocol';
import type { ClientLiveFrame, ServerLiveFrame } from '@velajs/live-protocol';
import {
  Container,
  DiscoveryService,
  Inject,
  Injectable,
  Optional,
  PipelineRunner,
  ReservedWsEvent,
  buildEntrypointExecutionContext,
  resolveScopedComponents,
  runInEntrypointScope,
} from '../index';
import type {
  ContributesEntrypoints,
  Entrypoint,
  OnApplicationBootstrap,
  ReservedWsEventHandler,
  Token,
  Type,
  WsClient,
  WsMessage,
} from '../index';
import { getLiveQueries } from './live.decorators';
import { encodeSubscriptionUpdate } from './live.delta';
import { LIVE_CURSOR_LOG, LIVE_DRIVER, LIVE_MODULE_OPTIONS, LIVE_RESOLVER_METADATA } from './live.tokens';
import type {
  CommitStamp,
  CursorLog,
  InvalidationCommand,
  LiveDriver,
  LiveEntrypointMeta,
  LiveIdentity,
  LiveInvalidationSink,
  LiveModuleOptions,
  LiveQueryContext,
  LiveQueryOptions,
  LiveResolverMetadata,
  SubscriptionRecord,
} from './live.types';
import { PresenceService } from './presence';

/** How many subscriptions refresh concurrently per flush (lunora's socket-pool default). */
const REFRESH_POOL_SIZE = 8;

interface RegisteredQuery {
  token: Type;
  methodName: string | symbol;
  options: LiveQueryOptions;
}

interface ConnectionEntry {
  client: WsClient;
  path: string;
  subs: Map<string, SubscriptionRecord>;
}

/**
 * Where the engine persists a connection's subscription records inside
 * `client.data` (committed through `WsClient.commit()`). On Cloudflare that
 * lands in the hibernation attachment, so subscriptions survive DO eviction;
 * the transport replays them via `restoreSubscription` on wake. On node,
 * `commit()` is a no-op and this is just in-memory bookkeeping.
 */
export const LIVE_SUBS_DATA_KEY = '__velaLiveSubs';

/** Read the subscription records a transport persisted for a connection (wake/restore path). */
export function readPersistedLiveSubscriptions(client: WsClient): SubscriptionRecord[] {
  const raw = (client.data as Record<string, unknown> | undefined)?.[LIVE_SUBS_DATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (record): record is SubscriptionRecord =>
      typeof record === 'object' &&
      record !== null &&
      typeof (record as SubscriptionRecord).sub === 'string' &&
      typeof (record as SubscriptionRecord).query === 'string' &&
      Array.isArray((record as SubscriptionRecord).tags),
  );
}

const defaultIdentity = (client: WsClient): LiveIdentity | undefined => {
  const data = client.data as Record<string, unknown> | undefined;
  if (!data || Object.keys(data).length === 0) return undefined;
  return { ...data } as LiveIdentity;
};

async function runPool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await run(item);
    }
  });
  await Promise.all(workers);
}

/**
 * The live-query engine of ONE log scope: routes `$live` frames (subscribe /
 * unsubscribe / presence), owns the subscription registry, and turns tag
 * invalidations into re-run → diff → push cycles.
 *
 * Delivery semantics (ported from lunora's `shard-do.ts` refresh loop):
 * - **Coalescing**: a burst of invalidations collapses into one flush; every
 *   committed invalidation is observed by a flush that STARTS after it
 *   committed (`applyInvalidation` appends to the log before arming the
 *   drain, and the drain re-loops while tags are pending).
 * - **At-least-once**: a subscription's diff baseline (`lastJson`) advances
 *   only when the frame left the socket; keyed deltas are idempotent on
 *   replay.
 * - **Frame suppression**: a byte-identical re-run sends `settled` — no
 *   payload, but the cursor still advances so client optimistic layers drop.
 * - **Outbound expiry**: a subscription whose captured identity lapsed is
 *   dropped (socket closed) before it receives another scoped push.
 * - **Cursor-before-run**: the stamp a frame carries is read BEFORE the
 *   re-run, so a result can only be NEWER than its cursor claims — an
 *   invalidation racing the run is re-observed by the next flush, never lost.
 *
 * Transports reach the engine via `app.entrypoints.ofKind('live')` (it
 * contributes itself) — the same contract the WebSocket triad uses.
 */
@ReservedWsEvent('$live')
@Injectable()
export class LiveEngine
  implements OnApplicationBootstrap, ContributesEntrypoints, ReservedWsEventHandler, LiveInvalidationSink
{
  private readonly queries = new Map<string, RegisteredQuery>();
  private readonly connections = new Map<string, ConnectionEntry>();
  private readonly pendingTags = new Set<string>();
  private drainChain: Promise<void> = Promise.resolve();
  private draining = false;

  constructor(
    @Inject(Container) private readonly container: Container,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(LIVE_CURSOR_LOG) private readonly log: CursorLog,
    @Inject(LIVE_DRIVER) driver: LiveDriver,
    @Inject(LIVE_MODULE_OPTIONS) private readonly options: LiveModuleOptions,
    @Optional() @Inject(PresenceService) private readonly presence?: PresenceService,
  ) {
    driver.bind(this);
    this.presence?.bindInvalidator((tags) => {
      void driver.dispatch({ tags });
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const found of this.discovery.providersWithMeta<LiveResolverMetadata>(LIVE_RESOLVER_METADATA)) {
      if (!found.instance) continue;
      for (const declared of getLiveQueries(found.metatype)) {
        if (this.queries.has(declared.name)) {
          const msg =
            `[vela] duplicate @LiveQuery('${declared.name}') ` +
            `(${found.metatype.name}); keeping the first.`;
          if (this.container.getDiagnostics() === 'throw') throw new Error(msg);
          console.warn(msg);
          continue;
        }
        this.queries.set(declared.name, {
          token: found.metatype,
          methodName: declared.methodName,
          options: declared.options,
        });
      }
    }
  }

  /** The `'live'` entrypoint — how transports (node registrar, CF DO bootstrap) find the engine. */
  collectEntrypoints(): Entrypoint<LiveEntrypointMeta>[] {
    return [{ kind: 'live', token: LiveEngine as unknown as Token, instance: this, meta: { engine: this } }];
  }

  // ---- ReservedWsEventHandler ----

  async handleReservedEvent(path: string, client: WsClient, message: WsMessage): Promise<void> {
    const frame = message.data;
    // Forward-compat: unknown frame shapes are ignored, not errors.
    if (!isClientLiveFrame(frame)) return;

    switch (frame.t) {
      case 'sub':
        await this.onSubscribe(path, client, frame);
        return;
      case 'unsub': {
        const conn = this.connections.get(client.id);
        if (!conn) return;
        conn.subs.delete(frame.sub);
        if (conn.subs.size === 0) this.connections.delete(client.id);
        await this.persistSubscriptions(conn);
        return;
      }
      case 'presence':
        if (this.presence?.enabled) {
          this.presence.beat(frame.room, client.id, frame.meta);
        }
        return;
    }
  }

  async handleSocketClose(_path: string, client: WsClient): Promise<void> {
    this.connections.delete(client.id);
    this.presence?.reap(client.id);
  }

  // ---- LiveInvalidationSink ----

  async applyInvalidation(cmd: InvalidationCommand): Promise<CommitStamp> {
    const stamp = await this.log.append(cmd.tags);
    for (const tag of cmd.tags) this.pendingTags.add(tag);
    this.scheduleDrain();
    return stamp;
  }

  /** Settles when every pending invalidation has been flushed (tests, graceful transports). */
  async whenIdle(): Promise<void> {
    do {
      await this.drainChain;
    } while (this.draining || this.pendingTags.size > 0);
  }

  /**
   * Re-attach a persisted subscription without the subscribe handshake — the
   * Cloudflare transport replays hibernation-attachment records through this
   * on wake. No frames are sent; the next relevant invalidation pushes.
   */
  restoreSubscription(path: string, client: WsClient, record: SubscriptionRecord): void {
    this.ensureConnection(path, client).subs.set(record.sub, record);
  }

  // ---- subscribe path ----

  private async onSubscribe(
    path: string,
    client: WsClient,
    frame: Extract<ClientLiveFrame, { t: 'sub' }>,
  ): Promise<void> {
    if (frame.v !== undefined && frame.v > LIVE_PROTOCOL) {
      this.sendFrame(client, {
        t: 'error',
        sub: frame.sub,
        code: LIVE_ERROR_CODES.UNSUPPORTED_PROTOCOL,
        message: `server speaks live protocol v${LIVE_PROTOCOL}, client asked for v${frame.v}`,
        fatal: true,
      });
      return;
    }

    const conn = this.ensureConnection(path, client);
    if (conn.subs.has(frame.sub)) {
      this.sendFrame(client, {
        t: 'error',
        sub: frame.sub,
        code: LIVE_ERROR_CODES.DUPLICATE_SUB,
        message: `subscription id '${frame.sub}' is already active on this socket`,
        fatal: false,
      });
      return;
    }

    const registered = this.queries.get(frame.query);
    if (!registered) {
      this.sendFrame(client, {
        t: 'error',
        sub: frame.sub,
        code: LIVE_ERROR_CODES.UNKNOWN_QUERY,
        message: `no @LiveQuery('${frame.query}') is registered`,
        fatal: true,
      });
      return;
    }

    let args: unknown = frame.args;
    if (registered.options.parse) {
      try {
        args = registered.options.parse(frame.args);
      } catch (err) {
        this.sendFrame(client, {
          t: 'error',
          sub: frame.sub,
          code: LIVE_ERROR_CODES.BAD_ARGS,
          message: err instanceof Error ? err.message : 'invalid subscription args',
          fatal: true,
        });
        return;
      }
    }

    // Resolver-tier guards run ONCE, here (app-wide guards already ran in the
    // dispatcher's reserved-event path). Re-runs are server-initiated and rely
    // on the identity captured below instead of re-authorizing.
    if (!(await this.runSubscribeGuards(registered, client, frame.query, args))) {
      this.sendFrame(client, {
        t: 'error',
        sub: frame.sub,
        code: LIVE_ERROR_CODES.FORBIDDEN,
        message: `subscription to '${frame.query}' was rejected`,
        fatal: true,
      });
      return;
    }

    const identity = (this.options.identity ?? defaultIdentity)(client);
    const tags =
      typeof registered.options.tags === 'function'
        ? registered.options.tags(args)
        : registered.options.tags;

    const record: SubscriptionRecord = {
      sub: frame.sub,
      query: frame.query,
      args,
      tags,
      key: frame.key ?? registered.options.key,
      identity,
    };
    conn.subs.set(frame.sub, record);
    await this.persistSubscriptions(conn);
    this.sendFrame(client, { t: 'ack', sub: frame.sub });

    // Resume: when the client's cursor is still explainable and none of the
    // subscription's tags were invalidated in the gap, a tiny `resume` frame
    // keeps its cached value — no re-run at all. The diff baseline stays
    // undefined, so the next relevant change sends a full snapshot.
    if (frame.sinceCursor !== undefined && frame.sinceEpoch !== undefined) {
      const verdict = await this.log.evaluateResume(frame.sinceCursor, frame.sinceEpoch, tags);
      if (verdict === 'resume') {
        const stamp = await this.log.current();
        if (this.sendFrame(client, { t: 'resume', sub: frame.sub, cursor: stamp.cursor, epoch: stamp.epoch })) {
          record.lastCursor = stamp.cursor;
        }
        return;
      }
    }

    await this.push(conn, record, await this.log.current(), { initial: true });
  }

  private async runSubscribeGuards(
    registered: RegisteredQuery,
    client: WsClient,
    query: string,
    args: unknown,
  ): Promise<boolean> {
    const guards = resolveScopedComponents('guard', registered.token, registered.methodName, this.container);
    if (guards.length === 0) return true;
    const context = buildEntrypointExecutionContext('live', registered.token, registered.methodName, {
      query,
      args,
      client,
    });
    try {
      for (const guard of guards) {
        if (!(await guard.canActivate(context))) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // ---- refresh path ----

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.drainChain = this.drainChain
      .then(() => this.drainLoop())
      .catch((err) => {
        if (this.container.getDiagnostics() !== 'silent') {
          console.warn('[vela] live refresh flush failed:', err);
        }
      })
      .finally(() => {
        this.draining = false;
        if (this.pendingTags.size > 0) this.scheduleDrain();
      });
  }

  private async drainLoop(): Promise<void> {
    while (this.pendingTags.size > 0) {
      const changed = new Set(this.pendingTags);
      this.pendingTags.clear();

      // The stamp is resolved once per pass, BEFORE the re-runs (lunora
      // resolves its CDC cut the same way): results can only be newer than
      // the cursor they carry.
      const stamp = await this.log.current();

      const work: Array<{ conn: ConnectionEntry; record: SubscriptionRecord }> = [];
      for (const conn of this.connections.values()) {
        for (const record of conn.subs.values()) {
          if (record.tags.some((tag) => changed.has(tag))) work.push({ conn, record });
        }
      }

      await runPool(work, REFRESH_POOL_SIZE, async ({ conn, record }) => {
        await this.push(conn, record, stamp, { initial: false });
      });
    }
  }

  private async push(
    conn: ConnectionEntry,
    record: SubscriptionRecord,
    stamp: CommitStamp,
    { initial }: { initial: boolean },
  ): Promise<void> {
    // Outbound expiry enforcement — the only place expiry CAN be enforced for
    // a passive subscriber.
    const expiresAt = record.identity?.expiresAt;
    if (typeof expiresAt === 'number' && expiresAt <= Date.now()) {
      this.connections.delete(conn.client.id);
      try {
        conn.client.close(1008, 'identity expired');
      } catch {
        // already gone
      }
      return;
    }

    let json: string;
    let result: unknown;
    try {
      result = await this.runQuery(record, conn.client);
      // `undefined` has no JSON form — normalize so the frame always carries
      // an explicit `snapshot` and the baseline stays a string.
      if (result === undefined) result = null;
      json = JSON.stringify(result);
    } catch (err) {
      if (initial) {
        conn.subs.delete(record.sub);
        this.sendFrame(conn.client, {
          t: 'error',
          sub: record.sub,
          code: LIVE_ERROR_CODES.INTERNAL,
          message: err instanceof Error ? err.message : 'live query failed',
          fatal: true,
        });
      } else if (this.container.getDiagnostics() !== 'silent') {
        // Transient: baseline untouched, the subscription retries next flush.
        console.warn(`[vela] live query '${record.query}' re-run failed (will retry):`, err);
      }
      return;
    }

    const frame = encodeSubscriptionUpdate(record, json, result, stamp, initial);
    if (this.sendFrame(conn.client, frame)) {
      record.lastJson = json;
      record.lastCursor = stamp.cursor;
    }
  }

  private async runQuery(record: SubscriptionRecord, client: WsClient): Promise<unknown> {
    const registered = this.queries.get(record.query);
    if (!registered) throw new Error(`live query '${record.query}' disappeared from the registry`);

    return runInEntrypointScope(this.container, async (scope) => {
      // Async seam: lazy resolver modules materialize, request-scoped
      // resolvers rebuild per run (mirrors queue dispatch).
      const instance = (await scope.resolveAsync(registered.token)) as Record<string | symbol, unknown>;
      const liveContext: LiveQueryContext = {
        identity: record.identity,
        clientId: client.id,
        rooms: [...client.rooms],
      };
      const context = buildEntrypointExecutionContext('live', registered.token, registered.methodName, {
        query: record.query,
        args: record.args,
        client,
      });
      const interceptors = resolveScopedComponents(
        'interceptor',
        registered.token,
        registered.methodName,
        scope,
      );
      return PipelineRunner.run({
        context,
        guards: [],
        interceptors,
        resolveArgs: async () => [record.args, liveContext],
        invoke: async (args) => {
          const method = instance[registered.methodName] as (...a: unknown[]) => unknown;
          return method.apply(instance, args);
        },
      });
    });
  }

  /**
   * Mirror the connection's records into `client.data` + `commit()` so
   * hibernating transports can replay them on wake. The volatile diff
   * baseline (`lastJson`/`lastCursor`) is deliberately stripped: it can be
   * large (the whole last result vs the 16 KiB attachment cap) and a lost
   * baseline just means the next relevant change sends a full snapshot.
   */
  private async persistSubscriptions(conn: ConnectionEntry): Promise<void> {
    const records = [...conn.subs.values()].map(
      ({ lastJson: _lastJson, lastCursor: _lastCursor, ...persisted }) => persisted,
    );
    try {
      (conn.client.data as Record<string, unknown>)[LIVE_SUBS_DATA_KEY] = records;
      await conn.client.commit();
    } catch (err) {
      if (this.container.getDiagnostics() !== 'silent') {
        console.warn('[vela] live subscription persistence failed (resume across eviction disabled):', err);
      }
    }
  }

  private ensureConnection(path: string, client: WsClient): ConnectionEntry {
    let conn = this.connections.get(client.id);
    if (!conn) {
      conn = { client, path, subs: new Map() };
      this.connections.set(client.id, conn);
    }
    return conn;
  }

  private sendFrame(client: WsClient, frame: ServerLiveFrame): boolean {
    try {
      client.sendRaw(encodeLiveEnvelope(frame));
      return true;
    } catch {
      return false;
    }
  }
}
