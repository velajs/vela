import type { WsClient } from '../websocket/websocket.types';
import type { LiveQueryDefinition } from '@velajs/live-protocol';

/**
 * Identity captured at subscribe time and replayed into every re-run of the
 * subscription's query — never re-read from the client afterwards. Free-form;
 * `expiresAtMs` (epoch ms) is the one recognized field: a lapsed identity drops
 * the socket before it receives another scoped push (outbound enforcement —
 * a passive subscriber never trips inbound checks).
 */
export interface LiveIdentity {
  [key: string]: unknown;
  expiresAtMs?: number;
}

/** Second positional argument every `@LiveQuery` handler receives. */
export interface LiveQueryContext {
  identity?: LiveIdentity;
  /** The subscribed connection's id. */
  clientId: string;
  /** Rooms the connection was in when it subscribed. */
  rooms: string[];
  /**
   * The route path of the gateway the connection subscribed through. Rooms
   * of different gateways may share an id; the path tells them apart.
   */
  path: string;
}

export interface LiveQueryOptions<A = unknown> {
  /**
   * Dependency tags this query's result is built from — the invalidation
   * contract. Static for the common case; the function form derives
   * per-entity tags from the (parsed) subscribe args and the subscribing
   * connection's context. Writes invalidate tags via
   * `LiveInvalidation.invalidate()` (the CRUD bridge does it automatically
   * with `crud:<table>` tags).
   */
  tags: string[] | ((args: A, context: LiveQueryContext) => string[]);
  /** Key field for incremental list deltas (default `'id'`). */
  key?: string;
  /**
   * Opt into flush-local resolver execution coalescing. Vela always prefixes
   * this partition with the query name and canonical parsed args. Returning the
   * same key asserts that the resolver AND its interceptors produce the same
   * result for those subscribers despite client/identity/room differences.
   *
   * Expiry, guards, and delivery authorization still run per subscription.
   * Return `undefined` to execute independently. Throws, empty/control-bearing
   * keys, and keys over 256 UTF-8 bytes also fail closed to an independent run.
   */
  coalesceBy?: (args: A, context: LiveQueryContext) => string | undefined;
}

/** One `@LiveQuery` declaration on a `@LiveResolver` class. */
export interface LiveQueryMetadata {
  /** The definition's name, which clients subscribe with. */
  name: string;
  methodName: string | symbol;
  definition: LiveQueryDefinition;
  key?: string;
  prepare(input: unknown): PreparedLiveQuery;
}

/** Bound typed callbacks after one successful parse of this subscription's input. */
export interface PreparedLiveQuery {
  readonly input: unknown;
  readonly args: unknown;
  tags(context: LiveQueryContext): string[];
  coalesceBy?: (context: LiveQueryContext) => string | undefined;
  invoke(instance: unknown, context: LiveQueryContext): unknown | Promise<unknown>;
}

/** Class-level marker meta written by `@LiveResolver()`. */
export interface LiveResolverMetadata {}

/** A position in this log scope's ordered invalidation log. */
export interface CommitStamp {
  cursor: number;
  epoch: string;
}

/**
 * Resume verdict for a reconnecting subscription:
 * - `'resume'` — nothing the subscription depends on changed while away; keep
 *   the client's cached value and just advance its cursor.
 * - `'rerun'` — a relevant tag was invalidated in the gap; re-run and snapshot.
 * - `'snapshot'` — the gap cannot be reasoned about (epoch fork, trimmed log,
 *   rollback); re-run and snapshot.
 */
export type ResumeVerdict = 'resume' | 'rerun' | 'snapshot';

/**
 * The ordered tag-invalidation log for ONE log scope (this process on
 * node/bun/deno; one Durable Object on Cloudflare). Cursor = monotonic
 * sequence; epoch = timeline token rolled whenever monotonicity can no longer
 * be guaranteed (process restart, DO reset).
 */
export interface CursorLog {
  append(tags: string[]): CommitStamp | Promise<CommitStamp>;
  current(): CommitStamp | Promise<CommitStamp>;
  evaluateResume(
    sinceCursor: number,
    sinceEpoch: string,
    subscriptionTags: string[],
  ): ResumeVerdict | Promise<ResumeVerdict>;
}

/** A tag invalidation crossing the driver seam. `room` addresses the log scope holding the subscribers (advisory for local delivery). */
export interface InvalidationCommand {
  room?: string;
  tags: string[];
  /** Origin instance id — lets pub/sub drivers drop their own echo. */
  origin?: string;
}

/** What a driver delivers invalidations INTO — the live engine of one log scope. */
export interface LiveInvalidationSink {
  applyInvalidation(cmd: InvalidationCommand): CommitStamp | Promise<CommitStamp>;
}

/**
 * Cross-boundary invalidation transport — the live sibling of the WebSocket
 * `SyncDriver`, carrying TAGS (re-run instructions) instead of pre-serialized
 * frames. `localLive()` is the in-core single-scope default; platform packages
 * (`durableObjectLive()` in @velajs/cloudflare, `redisLive()` in
 * websocket-node) implement it out-of-core. `dispatch` returns the commit
 * stamp of the targeted log scope when the driver can observe it.
 */
export interface LiveDriver {
  readonly kind: string;
  bind(sink: LiveInvalidationSink): void;
  dispatch(cmd: InvalidationCommand): CommitStamp | undefined | Promise<CommitStamp | undefined>;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
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

/**
 * Platform wiring for `LiveModule`: a runtime adapter registers one as the
 * global `LIVE_PLATFORM`. It supplies the defaults the module's options leave
 * open and binds the application's driver to the platform. Without one, the
 * module delivers locally (`localLive()`) with an in-memory cursor log.
 */
export interface LivePlatform {
  /** The driver used when `LiveModule` options name none. Return a fresh instance per call. */
  liveDriver(): LiveDriver;
  /** The cursor log used when `LiveModule` options name none; omitted means in-memory. */
  cursorLog?(): CursorLog | undefined;
  /**
   * Adopt the application's driver, configured or default, before it serves:
   * a platform driver reads its bindings and delivery mode here.
   */
  bindDriver?(driver: LiveDriver): void;
  /**
   * Read one room's live state where its subscriptions live, for
   * `LiveInspector`. Omitted means this application's engine holds them.
   */
  inspect?(room: string): Promise<LiveInspection>;
}

/** One live subscription as tracked by the engine (and persisted by transports that survive eviction). */
export interface SubscriptionRecord {
  sub: string;
  query: string;
  args: unknown;
  /** Frozen at subscribe from the (parsed) args. */
  tags: string[];
  /** Delta key field (subscribe-frame override wins over the handler option). */
  key?: string;
  identity?: LiveIdentity;
  /**
   * The last result this subscription confirmed on the wire (the delta diff
   * baseline). `undefined` after a cursor-resume: the server never re-ran the
   * query, so the next relevant change sends a full snapshot.
   */
  lastJson?: string;
  lastCursor?: number;
}

export interface LivePresenceOptions {
  /** Roster entries older than this are filtered at read time (default 30_000 ms). */
  ttlMs?: number;
}

export interface LiveModuleOptions {
  /**
   * Construct this application's invalidation driver. Called once per app;
   * always return a fresh instance so sinks and platform bindings cannot leak
   * between a Worker and its Durable Objects. Defaults to the platform's
   * driver (`LIVE_PLATFORM`), then `localLive()`. Resolve dependencies with
   * `LiveModule.forRootAsync` and capture them here.
   */
  driver?: () => LiveDriver | Promise<LiveDriver>;
  /**
   * Construct this application's ordered log. Defaults to the platform's log
   * (`LIVE_PLATFORM`), then a fresh in-memory log.
   */
  log?: () => CursorLog | Promise<CursorLog>;
  /**
   * Identity capture at subscribe. Default: a shallow copy of `client.data`
   * (whatever the app's upgrade/`handleConnection` auth stamped there), or
   * `undefined` when empty.
   */
  identity?: (client: WsClient) => LiveIdentity | undefined;
  /**
   * Re-run immediately before every resume/snapshot/delta delivery. Use this
   * for revocation or tenant-membership checks that can change after subscribe.
   * Errors and every value except exactly `true` revoke the socket fail-closed.
   */
  authorizeDelivery?: (context: LiveDeliveryAuthorizationContext) => boolean | Promise<boolean>;
  /** Maximum active subscriptions on one socket. Default 100. */
  maxSubscriptionsPerSocket?: number;
  /** Maximum matching subscription refreshes scheduled by one drain pass. Default 10,000. */
  maxRefreshFanout?: number;
  /** Maximum tags on one subscription or invalidation. Default 100. */
  maxTags?: number;
  /** Presence preset configuration; `false` disables the built-in resolver. */
  presence?: LivePresenceOptions | false;
}

export interface LiveDeliveryAuthorizationContext {
  identity?: LiveIdentity;
  query: string;
  args: unknown;
  client: WsClient;
}

/** Meta carried by the `'live'` entrypoint (transports reach the engine through it). */
export interface LiveEntrypointMeta {
  /** The engine — typed loosely to avoid a circular type edge; cast to `LiveEngine`. */
  engine: unknown;
}
