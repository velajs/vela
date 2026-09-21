import {
  LIVE_ERROR_CODES,
  LIVE_PROTOCOL,
  MAX_LIVE_FRAME_BYTES,
  encodeLiveEnvelope,
  isClientLiveFrame,
} from '@velajs/live-protocol';
import type { ClientLiveFrame, LiveErrorCode, ServerLiveFrame } from '@velajs/live-protocol';
import {
  Container,
  DiscoveryService,
  Inject,
  Injectable,
  Optional,
  PipelineRunner,
  ReservedWsEvent,
  WsDispatcher,
  buildEntrypointExecutionContext,
  isVelaError,
  resolveErrorReporter,
  resolveEntrypoint,
  resolveScopedComponentsAsync,
  trySendWebSocketFrame,
  runInEntrypointScope,
  toErrorBody,
} from '../index';
import type {
  ContributesEntrypoints,
  Entrypoint,
  OnApplicationBootstrap,
  ReservedWsEventHandler,
  Type,
  WsClient,
  WsMessage,
  WsExecutionContext,
} from '../index';
import { getLiveQueries } from './live.decorators';
import { liveCoalescingKey } from './live.coalescing';
import { encodeSubscriptionUpdate } from './live.delta';
import { readPersistedSubscriptionRecords } from './live.persistence';
import {
  LIVE_CURSOR_LOG,
  LIVE_DRIVER,
  LIVE_MODULE_OPTIONS,
  LIVE_RESOLVER_METADATA,
} from './live.tokens';
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
  LiveQueryMetadata,
  PreparedLiveQuery,
  LiveResolverMetadata,
  SubscriptionRecord,
} from './live.types';
import { PresenceService } from './presence';

/** How many subscriptions refresh concurrently per flush (lunora's socket-pool default). */
const REFRESH_POOL_SIZE = 8;
const DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET = 100;
const DEFAULT_MAX_REFRESH_FANOUT = 10_000;
const DEFAULT_MAX_TAGS = 100;
const MAX_TAG_BYTES = 256;
// A pass may contain 10k distinct subscriptions. Bound both key cardinality
// and fulfilled-result retention so opt-in sharing cannot become an isolate-
// memory multiplier when most partitions are unique.
const MAX_COALESCED_EXECUTIONS_PER_PASS = 256;
const MAX_COALESCED_RESULT_BYTES = 64 * 1024;
const MAX_COALESCED_RETAINED_BYTES = 2 * 1024 * 1024;
const textEncoder = new TextEncoder();

interface RegisteredQuery extends LiveQueryMetadata {
  token: Type<unknown>;
  moduleId: string;
}

interface ConnectionEntry {
  client: WsClient;
  path: string;
  connectedAt: number;
  subs: Map<string, SubscriptionRecord>;
}

/** Read-only operational metadata; excludes query arguments, results and identity claims. */
export interface LiveInspection {
  subscriptions: Array<{
    id: string;
    query: string;
    room: string;
    clientId: string;
    tags: string[];
    /** When this engine attached the connection, including after hibernation. */
    connectedAt: number;
  }>;
  rooms: Array<{ room: string; count: number; members: string[] }>;
}

interface QueryExecution {
  json: string;
  result: unknown;
}

interface CachedQueryExecution {
  promise: Promise<QueryExecution>;
  retainedBytes?: number;
}

interface QueryExecutionCache {
  entries: Map<string, CachedQueryExecution>;
  retainedBytes: number;
}

function removeCachedExecution(
  cache: QueryExecutionCache,
  key: string,
  entry: CachedQueryExecution,
): void {
  if (cache.entries.get(key) !== entry) return;
  cache.entries.delete(key);
  cache.retainedBytes -= entry.retainedBytes ?? 0;
}

function evictOldestSettledExecution(cache: QueryExecutionCache): boolean {
  for (const [key, entry] of cache.entries) {
    if (entry.retainedBytes === undefined) continue;
    removeCachedExecution(cache, key, entry);
    return true;
  }
  return false;
}

function resolveCachedExecution(
  cache: QueryExecutionCache,
  key: string,
  execute: () => Promise<QueryExecution>,
): Promise<QueryExecution> {
  const cached = cache.entries.get(key);
  if (cached !== undefined) {
    // Promote hits so the bounded fulfilled-result set behaves as an LRU.
    cache.entries.delete(key);
    cache.entries.set(key, cached);
    return cached.promise;
  }

  while (
    cache.entries.size >= MAX_COALESCED_EXECUTIONS_PER_PASS &&
    evictOldestSettledExecution(cache)
  ) {
    // Keep pending work joinable; evict only already-consumed results.
  }
  if (cache.entries.size >= MAX_COALESCED_EXECUTIONS_PER_PASS) return execute();

  const entry: CachedQueryExecution = { promise: execute() };
  cache.entries.set(key, entry);
  void entry.promise.then(
    (execution): undefined => {
      if (cache.entries.get(key) !== entry) return undefined;
      const resultBytes = textEncoder.encode(execution.json).byteLength;
      if (resultBytes > MAX_COALESCED_RESULT_BYTES) {
        removeCachedExecution(cache, key, entry);
        return undefined;
      }

      entry.retainedBytes = resultBytes;
      cache.retainedBytes += resultBytes;
      while (
        cache.retainedBytes > MAX_COALESCED_RETAINED_BYTES &&
        evictOldestSettledExecution(cache)
      ) {
        // Oldest fulfilled groups leave first; pending executions stay joinable.
      }
      return undefined;
    },
    (): undefined => {
      removeCachedExecution(cache, key, entry);
      return undefined;
    },
  );
  return entry.promise;
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
  return readPersistedSubscriptionRecords(client.data?.[LIVE_SUBS_DATA_KEY]);
}

const defaultIdentity = (client: WsClient): LiveIdentity | undefined => {
  const data = client.data;
  if (!data || Object.keys(data).length === 0) return undefined;
  const { [LIVE_SUBS_DATA_KEY]: _subscriptions, expiresAtMs, ...claims } = data;
  if (expiresAtMs === undefined) return claims;
  if (typeof expiresAtMs !== 'number' || !Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0) {
    throw new TypeError('live identity expiry must be a nonnegative safe integer');
  }
  return { ...claims, expiresAtMs };
};

async function runPool<T>(
  items: T[],
  size: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
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
  implements
    OnApplicationBootstrap,
    ContributesEntrypoints,
    ReservedWsEventHandler,
    LiveInvalidationSink
{
  private readonly queries = new Map<string, RegisteredQuery>();
  private readonly preparedQueries = new WeakMap<SubscriptionRecord, PreparedLiveQuery>();
  private readonly connections = new Map<string, ConnectionEntry>();
  private readonly pendingTags = new Set<string>();
  private drainChain: Promise<void> = Promise.resolve();
  private draining = false;
  private readonly maxSubscriptionsPerSocket: number;
  private readonly maxRefreshFanout: number;
  private readonly maxTags: number;

  constructor(
    @Inject(Container) private readonly container: Container,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(LIVE_CURSOR_LOG) private readonly log: CursorLog,
    @Inject(LIVE_DRIVER) driver: LiveDriver,
    @Inject(LIVE_MODULE_OPTIONS) private readonly options: LiveModuleOptions,
    @Optional() @Inject(PresenceService) private readonly presence?: PresenceService,
  ) {
    this.maxSubscriptionsPerSocket = this.boundedOption(
      options.maxSubscriptionsPerSocket,
      DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET,
      10_000,
      'maxSubscriptionsPerSocket',
    );
    this.maxRefreshFanout = this.boundedOption(
      options.maxRefreshFanout,
      DEFAULT_MAX_REFRESH_FANOUT,
      100_000,
      'maxRefreshFanout',
    );
    this.maxTags = this.boundedOption(options.maxTags, DEFAULT_MAX_TAGS, 1_000, 'maxTags');
    driver.bind(this);
    this.presence?.bindInvalidator((tags) => {
      void driver.dispatch({ tags });
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const found of this.discovery.registrationsWithMeta<LiveResolverMetadata>(
      LIVE_RESOLVER_METADATA,
      { metadataOnly: true },
    )) {
      for (const declared of getLiveQueries(found.metatype)) {
        if (this.queries.has(declared.name)) {
          const msg =
            `[vela] duplicate @LiveQuery('${declared.name}') ` +
            `(${found.metatype.name}, owner ${found.moduleId}); query names must be unique.`;
          throw new Error(msg);
        }
        this.queries.set(declared.name, {
          ...declared,
          token: found.metatype,
          moduleId: found.moduleId,
        });
      }
    }
  }

  /** The `'live'` entrypoint — how transports (node registrar, CF DO bootstrap) find the engine. */
  collectEntrypoints(): Entrypoint<LiveEntrypointMeta>[] {
    return [
      {
        kind: 'live',
        token: LiveEngine,
        instance: this,
        meta: { engine: this },
      },
    ];
  }

  // ---- ReservedWsEventHandler ----

  /** Snapshot of this engine's scope only. Expose through an authenticated admin surface. */
  inspect(): LiveInspection {
    const subscriptions: LiveInspection['subscriptions'] = [];
    for (const connection of this.connections.values()) {
      const expiry = connection.client.data.expiresAtMs;
      if (typeof expiry === 'number' && expiry <= Date.now()) continue;
      for (const record of connection.subs.values()) {
        for (const room of connection.client.rooms) {
          subscriptions.push({
            id: JSON.stringify([connection.path, room, connection.client.id, record.sub]),
            query: record.query,
            room,
            clientId: connection.client.id,
            tags: [...record.tags],
            connectedAt: connection.connectedAt,
          });
        }
      }
    }
    return { subscriptions, rooms: this.presence?.inspectRooms() ?? [] };
  }

  async handleReservedEvent(
    path: string,
    client: WsClient,
    message: WsMessage,
    context?: WsExecutionContext,
  ): Promise<void> {
    const frame = message.data;
    if (this.isUnsupportedSubscribeFrame(frame)) {
      this.sendFrame(client, {
        t: 'error',
        sub: frame.sub,
        code: LIVE_ERROR_CODES.UNSUPPORTED_PROTOCOL,
        message: `server speaks live protocol v${LIVE_PROTOCOL}, client asked for v${frame.v}`,
        fatal: true,
      });
      return;
    }
    // Forward-compat: unknown frame shapes are ignored, not errors.
    if (!isClientLiveFrame(frame)) return;

    switch (frame.t) {
      case 'sub':
        await this.onSubscribe(path, client, frame, context?.getContainer());
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
          // Presence is an authorization-sensitive room operation.  A frame
          // may only name a room the trusted transport already joined for
          // this socket; client-supplied room strings never create membership.
          if (!client.rooms.has(frame.room)) {
            this.connections.delete(client.id);
            this.presence.reap(client.id);
            client.close(1008, 'presence room not joined');
            return;
          }
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
    this.assertTags(cmd.tags, 'invalidation');
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
    const conn = this.ensureConnection(path, client);
    if (conn.subs.size >= this.maxSubscriptionsPerSocket || !this.isRestorableRecord(record)) {
      void this.revokeConnection(conn, 'invalid persisted live subscription');
      return;
    }
    try {
      const registered = this.queries.get(record.query);
      if (!registered) throw new Error('unknown persisted live query');
      const prepared = registered.prepare(record.args);
      const tags = prepared.tags();
      this.assertTags(tags, 'restored subscription');
      const restored: SubscriptionRecord = {
        sub: record.sub,
        query: record.query,
        args: prepared.args,
        tags,
        key: record.key ?? registered.key,
        identity: record.identity,
      };
      this.preparedQueries.set(restored, prepared);
      conn.subs.set(restored.sub, restored);
    } catch {
      void this.revokeConnection(conn, 'invalid persisted live subscription');
    }
  }

  // ---- subscribe path ----

  private async onSubscribe(
    path: string,
    client: WsClient,
    frame: Extract<ClientLiveFrame, { t: 'sub' }>,
    invocationScope?: Container,
  ): Promise<void> {
    if (!invocationScope)
      return runInEntrypointScope(this.container, (scope) =>
        this.onSubscribe(path, client, frame, scope),
      );

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

    if (conn.subs.size >= this.maxSubscriptionsPerSocket) {
      this.sendFrame(client, {
        t: 'error',
        sub: frame.sub,
        code: LIVE_ERROR_CODES.LIMIT_EXCEEDED,
        message: `a socket may have at most ${this.maxSubscriptionsPerSocket} live subscriptions`,
        fatal: true,
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

    let prepared: PreparedLiveQuery;
    try {
      prepared = registered.prepare(frame.args);
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
    const args = prepared.args;

    // Resolver-tier guards run here and again before server-initiated delivery.
    // App-wide guards already protected the inbound reserved-event path.
    if (!(await this.runSubscribeGuards(registered, client, frame.query, args, invocationScope))) {
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
    let tags: string[];
    try {
      tags = prepared.tags();
      this.assertTags(tags, `subscription '${frame.query}'`);
    } catch (err) {
      resolveErrorReporter(this.container).report(err, {
        edge: 'live',
        source: frame.query,
      });
      this.sendFrame(client, {
        t: 'error',
        sub: frame.sub,
        code: LIVE_ERROR_CODES.INTERNAL,
        message: 'Internal Server Error',
        fatal: true,
      });
      return;
    }

    const record: SubscriptionRecord = {
      sub: frame.sub,
      query: frame.query,
      args,
      tags,
      key: frame.key ?? registered.key,
      identity,
    };
    this.preparedQueries.set(record, prepared);
    if (!(await this.authorizeRecord(record, client, false, invocationScope))) {
      await this.revokeConnection(conn, 'live authorization revoked');
      return;
    }
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
        if (
          this.sendFrame(client, {
            t: 'resume',
            sub: frame.sub,
            cursor: stamp.cursor,
            epoch: stamp.epoch,
          })
        ) {
          record.lastCursor = stamp.cursor;
        }
        return;
      }
    }

    await this.push(conn, record, await this.log.current(), {
      initial: true,
      scope: invocationScope,
    });
  }

  private async runSubscribeGuards(
    registered: RegisteredQuery,
    client: WsClient,
    query: string,
    args: unknown,
    scope: Container,
  ): Promise<boolean> {
    const context = buildEntrypointExecutionContext(
      'live',
      registered.token,
      registered.methodName,
      { query, args, client },
      registered.moduleId,
      scope,
    );
    try {
      const guards = await resolveScopedComponentsAsync(
        'guard',
        registered.token,
        registered.methodName,
        scope,
        registered.moduleId,
      );
      for (const guard of guards) if (!(await guard.canActivate(context))) return false;
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
      const overflow = new Set<ConnectionEntry>();
      for (const conn of this.connections.values()) {
        for (const record of conn.subs.values()) {
          if (!record.tags.some((tag) => changed.has(tag))) continue;
          if (work.length < this.maxRefreshFanout) work.push({ conn, record });
          else overflow.add(conn);
        }
      }

      await Promise.all(
        [...overflow].map((conn) =>
          this.revokeConnection(conn, 'live invalidation fan-out limit exceeded'),
        ),
      );

      const authorizedWork = work.filter(({ conn }) => !overflow.has(conn));
      // Fresh for every pass: explicit tags still decide which records enter
      // this work set, and no result can survive into a later invalidation cut.
      const runCache: QueryExecutionCache = { entries: new Map(), retainedBytes: 0 };
      await runPool(authorizedWork, REFRESH_POOL_SIZE, async ({ conn, record }) => {
        await this.push(conn, record, stamp, { initial: false, runCache });
      });
    }
  }

  /**
   * Map a resolver failure to its live error-frame code. A branded
   * {@link VelaError} carries an HTTP-ish status that projects onto the live
   * vocabulary (403 → forbidden, 400/422 → bad_args); everything else — and
   * every unbranded error — is `internal` (the client sees a redacted message).
   */
  private static liveFrameCode(err: unknown): LiveErrorCode {
    if (!isVelaError(err)) return LIVE_ERROR_CODES.INTERNAL;
    if (err.status === 403) return LIVE_ERROR_CODES.FORBIDDEN;
    if (err.status === 400 || err.status === 422) return LIVE_ERROR_CODES.BAD_ARGS;
    return LIVE_ERROR_CODES.INTERNAL;
  }

  private async push(
    conn: ConnectionEntry,
    record: SubscriptionRecord,
    stamp: CommitStamp,
    {
      initial,
      runCache,
      scope,
    }: { initial: boolean; runCache?: QueryExecutionCache; scope?: Container },
  ): Promise<void> {
    if (!scope)
      return runInEntrypointScope(this.container, (child) =>
        this.push(conn, record, stamp, { initial, runCache, scope: child }),
      );
    // Outbound expiry enforcement — the only place expiry CAN be enforced for
    // a passive subscriber.
    const expiresAtMs = record.identity?.expiresAtMs;
    if (
      expiresAtMs !== undefined &&
      (typeof expiresAtMs !== 'number' ||
        !Number.isSafeInteger(expiresAtMs) ||
        expiresAtMs <= Date.now())
    ) {
      await this.revokeConnection(conn, 'identity expired');
      return;
    }

    if (!initial && !(await this.authorizeRecord(record, conn.client, true, scope))) {
      await this.revokeConnection(conn, 'live authorization revoked');
      return;
    }

    let execution: QueryExecution;
    try {
      execution = await this.resolveQueryExecution(record, conn.client, runCache, scope);
    } catch (err) {
      if (initial) {
        // Close the leak: an initial-subscribe resolver failure is REDACTED
        // through `toErrorBody` (the single wire-redaction seam) — an unbranded
        // error's raw message never reaches the browser, it surfaces only via
        // the reporter. Branded VelaErrors keep their client-facing message.
        conn.subs.delete(record.sub);
        await this.persistSubscriptions(conn);
        const reporter = resolveErrorReporter(this.container);
        reporter.report(err, { edge: 'live', source: record.query });
        const safe = toErrorBody(err, { catalog: reporter.catalog });
        this.sendFrame(conn.client, {
          t: 'error',
          sub: record.sub,
          code: LiveEngine.liveFrameCode(err),
          message: safe.body.error.message,
          fatal: true,
        });
      } else if (this.container.getDiagnostics() !== 'silent') {
        // Transient: baseline untouched, the subscription retries next flush.
        console.warn(`[vela] live query '${record.query}' re-run failed (will retry):`, err);
      }
      return;
    }

    const frame = encodeSubscriptionUpdate(
      record,
      execution.json,
      execution.result,
      stamp,
      initial,
    );
    if (this.sendFrame(conn.client, frame)) {
      record.lastJson = execution.json;
      record.lastCursor = stamp.cursor;
    }
  }

  private liveQueryContext(record: SubscriptionRecord, client: WsClient): LiveQueryContext {
    return {
      identity: record.identity,
      clientId: client.id,
      rooms: [...client.rooms],
    };
  }

  private async resolveQueryExecution(
    record: SubscriptionRecord,
    client: WsClient,
    runCache: QueryExecutionCache | undefined,
    scope: Container,
  ): Promise<QueryExecution> {
    const registered = this.queries.get(record.query);
    if (!registered) throw new Error(`live query '${record.query}' disappeared from the registry`);

    let cacheKey: string | undefined;
    let liveContext: LiveQueryContext | undefined;
    const prepared = this.preparedQuery(record);
    if (runCache && prepared.coalesceBy) {
      try {
        liveContext = this.liveQueryContext(record, client);
        const partition = prepared.coalesceBy(liveContext);
        if (typeof partition === 'string') {
          cacheKey = liveCoalescingKey(record.query, record.args, partition);
        }
      } catch {
        // App partitioning is an optimization assertion, never a delivery
        // dependency. A faulty key function fails closed to an independent run.
      }
    }

    if (cacheKey === undefined || runCache === undefined) {
      return this.executeQuery(record, client, scope, liveContext);
    }

    // Store the in-flight Promise, not just its result: workers reaching the
    // same group concurrently join the first resolver execution. Fulfilled
    // groups remain pass-local but are held behind strict count/byte budgets.
    return resolveCachedExecution(runCache, cacheKey, () =>
      this.executeQuery(record, client, scope, liveContext),
    );
  }

  private async executeQuery(
    record: SubscriptionRecord,
    client: WsClient,
    scope: Container,
    liveContext?: LiveQueryContext,
  ): Promise<QueryExecution> {
    const registered = this.queries.get(record.query);
    if (!registered) throw new Error(`live query '${record.query}' disappeared from the registry`);
    const result = registered.definition.result.parse(
      await this.runQuery(record, client, scope, liveContext),
    );
    const json = JSON.stringify(result);
    if (json === undefined)
      throw new TypeError('A live query result must have a JSON representation.');
    // Delivery is a JSON protocol. Retain and fan out the canonical parsed
    // wire value rather than the resolver's raw object graph: non-enumerable,
    // symbol, alias, and custom-instance state must not bypass cache budgets or
    // make the baseline differ from the snapshot that actually gets encoded.
    const wireResult: unknown = JSON.parse(json);
    return { json, result: wireResult };
  }

  private async runQuery(
    record: SubscriptionRecord,
    client: WsClient,
    scope: Container,
    liveContext?: LiveQueryContext,
  ): Promise<unknown> {
    const registered = this.queries.get(record.query);
    if (!registered) throw new Error(`live query '${record.query}' disappeared from the registry`);

    // Resolve the handler only after authorization and preserve its module owner.
    const prepared = this.preparedQuery(record);
    const queryContext = liveContext ?? this.liveQueryContext(record, client);
    const context = buildEntrypointExecutionContext(
      'live',
      registered.token,
      registered.methodName,
      {
        query: record.query,
        args: record.args,
        client,
      },
      registered.moduleId,
      scope,
    );
    const interceptors = await resolveScopedComponentsAsync(
      'interceptor',
      registered.token,
      registered.methodName,
      scope,
      registered.moduleId,
    );
    return PipelineRunner.run({
      context,
      guards: [],
      interceptors,
      resolveArgs: async () => [record.args, queryContext],
      invoke: async () => prepared.invoke(await resolveEntrypoint(scope, registered), queryContext),
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
    const records = [...conn.subs.values()].map((record) => ({
      sub: record.sub,
      query: record.query,
      args: this.preparedQuery(record).input,
      tags: record.tags,
      key: record.key,
      identity: record.identity,
    }));
    try {
      conn.client.data[LIVE_SUBS_DATA_KEY] = records;
      await conn.client.commit();
    } catch (err) {
      if (this.container.getDiagnostics() !== 'silent') {
        console.warn(
          '[vela] live subscription persistence failed (resume across eviction disabled):',
          err,
        );
      }
    }
  }

  private preparedQuery(record: SubscriptionRecord): PreparedLiveQuery {
    const prepared = this.preparedQueries.get(record);
    if (!prepared) throw new Error(`live query '${record.query}' has not parsed its input`);
    return prepared;
  }

  private ensureConnection(path: string, client: WsClient): ConnectionEntry {
    let conn = this.connections.get(client.id);
    if (!conn) {
      conn = { client, path, connectedAt: Date.now(), subs: new Map() };
      this.connections.set(client.id, conn);
    }
    return conn;
  }

  private async authorizeRecord(
    record: SubscriptionRecord,
    client: WsClient,
    rerunScopedGuards: boolean,
    scope: Container,
  ): Promise<boolean> {
    const registered = this.queries.get(record.query);
    if (!registered) return false;
    try {
      const dispatcher = this.container.resolve(WsDispatcher);
      if (
        !(await dispatcher.authorizeDelivery(
          this.connections.get(client.id)?.path ?? '',
          client,
          scope,
        ))
      ) {
        return false;
      }
    } catch {
      return false;
    }
    if (
      rerunScopedGuards &&
      !(await this.runSubscribeGuards(registered, client, record.query, record.args, scope))
    ) {
      return false;
    }
    if (!this.options.authorizeDelivery) return true;
    try {
      return (
        (await this.options.authorizeDelivery({
          identity: record.identity,
          query: record.query,
          args: record.args,
          client,
        })) === true
      );
    } catch {
      return false;
    }
  }

  private async revokeConnection(conn: ConnectionEntry, reason: string): Promise<void> {
    this.connections.delete(conn.client.id);
    conn.subs.clear();
    this.presence?.reap(conn.client.id);
    await this.persistSubscriptions(conn);
    try {
      conn.client.close(1008, reason);
    } catch {
      // already closed
    }
  }

  private assertTags(tags: unknown, source: string): asserts tags is string[] {
    if (
      !Array.isArray(tags) ||
      tags.length === 0 ||
      tags.length > this.maxTags ||
      tags.some(
        (tag) =>
          typeof tag !== 'string' ||
          tag.length === 0 ||
          textEncoder.encode(tag).byteLength > MAX_TAG_BYTES ||
          /[\u0000-\u001f\u007f]/.test(tag),
      )
    ) {
      throw new Error(
        `[vela] ${source} tags must contain 1-${this.maxTags} bounded, control-free strings`,
      );
    }
  }

  private isRestorableRecord(record: SubscriptionRecord): boolean {
    if (
      typeof record.sub !== 'string' ||
      record.sub.length === 0 ||
      typeof record.query !== 'string' ||
      record.query.length === 0 ||
      !this.queries.has(record.query)
    ) {
      return false;
    }
    try {
      this.assertTags(record.tags, 'persisted subscription');
      return true;
    } catch {
      return false;
    }
  }

  private boundedOption(
    value: number | undefined,
    fallback: number,
    maximum: number,
    name: string,
  ): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
      throw new Error(`[vela] LiveModule ${name} must be an integer between 1 and ${maximum}`);
    }
    return resolved;
  }

  private isUnsupportedSubscribeFrame(
    value: unknown,
  ): value is { t: 'sub'; sub: string; query: string; v: number } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return (
      't' in value &&
      value.t === 'sub' &&
      'sub' in value &&
      typeof value.sub === 'string' &&
      value.sub.length > 0 &&
      value.sub.length <= 256 &&
      'query' in value &&
      typeof value.query === 'string' &&
      value.query.length > 0 &&
      value.query.length <= 256 &&
      'v' in value &&
      typeof value.v === 'number' &&
      Number.isSafeInteger(value.v) &&
      value.v > 0 &&
      value.v !== LIVE_PROTOCOL
    );
  }

  private sendFrame(client: WsClient, frame: ServerLiveFrame): boolean {
    try {
      const encoded = encodeLiveEnvelope(frame);
      if (textEncoder.encode(encoded).byteLength > MAX_LIVE_FRAME_BYTES) return false;
      return trySendWebSocketFrame(client, encoded) === 'accepted';
    } catch {
      return false;
    }
  }
}
