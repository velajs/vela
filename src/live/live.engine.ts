import {
  LIVE_ERROR_CODES,
  LIVE_PROTOCOL,
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
  resolveScopedComponents,
  runInEntrypointScope,
  toErrorBody,
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
  LiveQueryOptions,
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
const textEncoder = new TextEncoder();

interface RegisteredQuery {
  token: Type;
  moduleId: string;
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
    for (const found of this.discovery.providersWithMeta<LiveResolverMetadata>(
      LIVE_RESOLVER_METADATA,
    )) {
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
          moduleId: found.moduleIds[0]!,
          methodName: declared.methodName,
          options: declared.options,
        });
      }
    }
  }

  /** The `'live'` entrypoint — how transports (node registrar, CF DO bootstrap) find the engine. */
  collectEntrypoints(): Entrypoint<LiveEntrypointMeta>[] {
    return [
      {
        kind: 'live',
        token: LiveEngine as unknown as Token,
        instance: this,
        meta: { engine: this },
      },
    ];
  }

  // ---- ReservedWsEventHandler ----

  async handleReservedEvent(path: string, client: WsClient, message: WsMessage): Promise<void> {
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
    conn.subs.set(record.sub, record);
  }

  // ---- subscribe path ----

  private async onSubscribe(
    path: string,
    client: WsClient,
    frame: Extract<ClientLiveFrame, { t: 'sub' }>,
  ): Promise<void> {
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

    // Resolver-tier guards run here and again before server-initiated delivery.
    // App-wide guards already protected the inbound reserved-event path.
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
    try {
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
      key: frame.key ?? registered.options.key,
      identity,
    };
    if (!(await this.authorizeRecord(record, client, false))) {
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

    await this.push(conn, record, await this.log.current(), { initial: true });
  }

  private async runSubscribeGuards(
    registered: RegisteredQuery,
    client: WsClient,
    query: string,
    args: unknown,
  ): Promise<boolean> {
    const guards = resolveScopedComponents(
      'guard',
      registered.token,
      registered.methodName,
      this.container,
    );
    if (guards.length === 0) return true;
    const context = buildEntrypointExecutionContext(
      'live',
      registered.token,
      registered.methodName,
      {
        query,
        args,
        client,
      },
      registered.moduleId,
    );
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
      await runPool(authorizedWork, REFRESH_POOL_SIZE, async ({ conn, record }) => {
        await this.push(conn, record, stamp, { initial: false });
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
    { initial }: { initial: boolean },
  ): Promise<void> {
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

    if (!initial && !(await this.authorizeRecord(record, conn.client, true))) {
      await this.revokeConnection(conn, 'live authorization revoked');
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
      const instance = (await scope.resolveAsync(registered.token)) as Record<
        string | symbol,
        unknown
      >;
      const liveContext: LiveQueryContext = {
        identity: record.identity,
        clientId: client.id,
        rooms: [...client.rooms],
      };
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
      );
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
        console.warn(
          '[vela] live subscription persistence failed (resume across eviction disabled):',
          err,
        );
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

  private async authorizeRecord(
    record: SubscriptionRecord,
    client: WsClient,
    rerunScopedGuards: boolean,
  ): Promise<boolean> {
    const registered = this.queries.get(record.query);
    if (!registered) return false;
    try {
      const dispatcher = this.container.resolve(WsDispatcher);
      if (
        !(await dispatcher.authorizeDelivery(this.connections.get(client.id)?.path ?? '', client))
      ) {
        return false;
      }
    } catch {
      return false;
    }
    if (
      rerunScopedGuards &&
      !(await this.runSubscribeGuards(registered, client, record.query, record.args))
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
    const frame = value as Record<string, unknown>;
    return (
      frame.t === 'sub' &&
      typeof frame.sub === 'string' &&
      frame.sub.length > 0 &&
      frame.sub.length <= 256 &&
      typeof frame.query === 'string' &&
      frame.query.length > 0 &&
      frame.query.length <= 256 &&
      typeof frame.v === 'number' &&
      Number.isSafeInteger(frame.v) &&
      frame.v > 0 &&
      frame.v !== LIVE_PROTOCOL
    );
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
