import type { LiveQueryDefinition } from '@velajs/live-protocol';
/** The value contract projected from a shared live-query schema map. */
export interface LiveContract {
  [query: string]: { args: unknown; result: unknown };
}

/** Validate named interfaces without requiring an open string index signature. */
export type LiveContractShape<C> = { [Query in keyof C]: { args: unknown; result: unknown } };

/** Typed mutation results require runtime evidence at the HTTP boundary. */
export interface MutationResultOptions<Result> extends MutateOptions {
  parseResult(value: unknown): Result;
}

export type ArgsOf<C extends LiveContractShape<C>, Q extends keyof C> = C[Q]['args'];
export type ResultOf<C extends LiveContractShape<C>, Q extends keyof C> = C[Q]['result'];

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'offline' | 'closed';

/** The WebSocket surface the client uses — injectable for SSR/tests/non-browser runtimes. */
export interface WebSocketLike {
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface ReconnectOptions {
  /** First-retry floor (default 250 ms). */
  baseMs?: number;
  /** Backoff ceiling (default 30 000 ms). */
  capMs?: number;
}

export type LiveQueryParsers<Args, Result> = LiveQueryDefinition<Args, Result>;
export type LiveQuerySchemas<C extends LiveContractShape<C>> = {
  [Q in keyof C]: LiveQueryParsers<C[Q]['args'], C[Q]['result']>;
};

export interface LiveClientOptions<C extends LiveContractShape<C> = LiveContract> {
  /** Runtime evidence for every typed query. Share these schemas with the server. */
  queries: LiveQuerySchemas<C>;
  /** HTTP(S) base of the Vela app, e.g. `https://api.example.com`. */
  url: string;
  /** WS(S) base override; derived from `url` (http→ws) when omitted. */
  wsUrl?: string;
  /**
   * Gateway path template the live socket connects to. A `:room` placeholder
   * is substituted per subscription room (matching vela's node transport,
   * which auto-joins the `:id` route param, and Cloudflare's one-DO≈one-room
   * model). Default `/rooms/:room/ws`.
   */
  wsPath?: string;
  /** Room used when a subscribe/mutate call names none. Default `'default'`. */
  defaultRoom?: string;

  /** Injectables — the core never touches globals directly (SSR/edge safety). */
  WebSocket?: WebSocketFactory;
  fetch?: typeof fetch;

  /**
   * Async HTTP token provider, re-invoked per mutation and sent as a Bearer
   * header. It is never placed in a WebSocket URL.
   */
  authToken?: () => string | undefined | Promise<string | undefined>;
  /**
   * Optional short-lived, room-bound, single-use socket ticket provider. The
   * server should expire tickets within 30 seconds. Browser apps may omit this
   * and authenticate sockets with secure cookies plus server-side Origin checks.
   */
  socketTicket?: (room: string) => string | undefined | Promise<string | undefined>;

  /**
   * Framework `$ping` keepalive cadence (default 30 000 ms; Cloudflare answers
   * without waking the Durable Object). Also drives half-open socket detection;
   * the watchdog activates after the peer proves support with `$pong`, so older
   * Vela servers remain compatible. Set to `0` or less to disable both.
   */
  heartbeatIntervalMs?: number;
  reconnect?: ReconnectOptions;

  /** Durable store for the offline mutation queue. Omit → in-memory queue (lost on reload). */
  mutationStore?: MutationStore;
  /**
   * Enable/configure the offline mutation queue. `true` = defaults; omit = no
   * queue (today's behavior: `mutate()` fetches and may throw).
   */
  offline?: boolean | OfflineQueueOptions;
  /** App/schema version stamped on persisted writes; stale-version records purged on hydrate. */
  persistenceVersion?: string;
  /**
   * Issuing account+login-epoch provider; required for offline mutations,
   * used as the durable partition, stamped on enqueue, and rechecked on replay.
   * After changing/clearing it on logout, call
   * `client.purgeOfflineMutations(previousIdentity)` for the old epoch.
   */
  identity?: () => string | null | undefined;
  /** Explicitly scoped cross-tab coordination via BroadcastChannel. Off by default. */
  crossTab?: CrossTabOptions;
}

export interface SubscribeOptions {
  room?: string;
  /** Delta key-field override forwarded to the server (default `'id'`). */
  key?: string;
  onError?: (error: { code: string; message: string; fatal: boolean }) => void;
}

/** Single-subscription optimistic target for `mutate()`. */
export interface OptimisticTarget<T = unknown> {
  query: string;
  args?: unknown;
  room?: string;
  apply: (current: T | undefined) => T;
}

/** Multi-subscription optimistic store (the `optimisticUpdate` callback's argument). */
export interface LiveStore {
  get(query: string, args?: unknown, room?: string): unknown;
  set(
    query: string,
    args: unknown,
    next: unknown | ((current: unknown) => unknown),
    room?: string,
  ): void;
}

export interface MutateOptions {
  method?: string;
  headers?: Record<string, string>;
  room?: string;
  optimistic?: OptimisticTarget;
  optimisticUpdate?: (store: LiveStore) => void;
  /**
   * OCC / staleness guard evaluated just before offline replay; `false` ⇒ the
   * queued write is dropped with code `OFFLINE_PRECONDITION_FAILED` (not
   * replayed). See {@link createSnapshotPrecondition}.
   */
  precondition?: () => boolean;
  /** Per-call force direct fetch even when a queue is configured. */
  offline?: false;
}

export type Unsubscribe = () => void;

/** Seed states before the socket connects (SSR hydration). */
export interface HydrationEntry {
  query: string;
  args?: unknown;
  room?: string;
  value: unknown;
  cursor?: number;
  epoch?: string;
}

// ---- offline mutation queue (goal b) ----

/**
 * Durable FIFO store for the offline mutation queue (BYO storage). The client
 * owns the queue + replay logic; this only persists/loads/removes records.
 * `load()` MUST return records in append (FIFO) order within the supplied
 * authenticated account/epoch partition.
 */
export interface MutationStore {
  append(record: PersistedMutation, scope: MutationStoreScope): Promise<void>;
  load(scope: MutationStoreScope): Promise<PersistedMutation[]>;
  remove(id: string, scope: MutationStoreScope): Promise<void>;
  clear(scope: MutationStoreScope): Promise<void>;
}

/** Authenticated account/epoch partition for durable offline records. */
export interface MutationStoreScope {
  account: string;
}

/**
 * A serializable offline mutation replayed after a reload. Optimistic
 * transforms (functions) are NOT persisted — a hydrated record replays for
 * durability only.
 */
export interface PersistedMutation {
  id: string;
  path: string;
  body?: unknown;
  method?: string;
  headers?: Record<string, string>;
  room?: string;
  /**
   * Issuing account+login-epoch fingerprint. It selects the durable store
   * partition and is rechecked before replay.
   */
  identity: string;
  /**
   * App/schema version stamp; a record whose version !== the current
   * `persistenceVersion` is dropped + purged on hydrate. Absent = no gating.
   */
  version?: string;
}

export interface OfflineQueueOptions {
  /** Cap; oldest is evicted with code `OFFLINE_QUEUE_OVERFLOW`. Default 1000. */
  maxItems?: number;
  /** Queue even before the first successful connect (offline-first). Default false. */
  queueBeforeFirstConnect?: boolean;
  /** Called when a MutationStore op rejects (e.g. quota). Default: console.warn. */
  onError?: (ctx: {
    operation: 'append' | 'load' | 'remove' | 'clear';
    error: unknown;
    id?: string;
  }) => void;
}

export type MutationVerdict = 'committed' | 'rejected' | 'dropped';

/**
 * Terminal-verdict observer event — the ONLY channel for a hydrated
 * (post-reload, awaiter-less) write's outcome. `hadAwaiter` maps to a live
 * `mutate()` promise.
 */
export interface MutationSettledEvent {
  path: string;
  status: MutationVerdict;
  code?: string;
  hadAwaiter: boolean;
}

// ---- cross-tab coordination (goal c) ----

/**
 * The `BroadcastChannel` surface the coordinator uses — injectable for
 * tests/non-browser runtimes, mirroring the existing {@link WebSocketLike}
 * seam rather than depending on the DOM `BroadcastChannel` type.
 */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export type BroadcastChannelFactory = (name: string) => BroadcastChannelLike;

export interface CrossTabOptions {
  /** Stable application namespace. Required to prevent unrelated apps sharing a channel. */
  appId: string;
  /** Authenticated session identifier/fingerprint. Never use a bearer token here. */
  sessionId: string;
  /** Monotonic login/account epoch; recreate the client whenever it changes. */
  accountEpoch: string;
  /** Optional channel prefix. Default `'velajs-live'`. */
  channelName?: string;
  /** Leader heartbeat cadence. Default 1000 ms. */
  heartbeatMs?: number;
  /** Followers reclaim after this long without a heartbeat. Default 3000 ms (must exceed heartbeatMs). */
  leaderTimeoutMs?: number;
  /** Injectable for tests / non-browser. Default `globalThis.BroadcastChannel`. */
  BroadcastChannel?: BroadcastChannelFactory;
}

// ---- client-query store ----

/** A handle to a local-only reactive value (see `createClientQuery`). `defaultValue` carries `T`. */
export interface ClientQueryRef<T> {
  readonly key: string;
  readonly defaultValue: T;
  readonly read: (owner: object) => T;
  readonly write: (owner: object, value: T) => void;
  readonly observe: (owner: object, listener: () => void) => Unsubscribe;
}

/** Project the values produced by a schema map into the client's query contract. */
export type InferLiveContract<S extends LiveQuerySchemas<LiveContract>> = {
  [Q in keyof S]: {
    args: ReturnType<S[Q]['args']['parse']>;
    result: ReturnType<S[Q]['result']['parse']>;
  };
};
