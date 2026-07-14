/**
 * The app-supplied typing contract: one entry per live query, keyed by the
 * server's `@LiveQuery(name)`. Hand-written in v1; shaped so a future
 * `vela codegen` emission (from OpenAPI operationIds + live metadata) is a
 * drop-in replacement.
 *
 * ```ts
 * interface AppLive {
 *   'todos.list': { args: { listId: string }; result: Todo[] };
 * }
 * const client = new LiveClient<AppLive>({ url });
 * ```
 */
export interface LiveContract {
  [query: string]: { args: unknown; result: unknown };
}

export type ArgsOf<C, Q extends keyof C> = C[Q] extends { args: infer A } ? A : never;
export type ResultOf<C, Q extends keyof C> = C[Q] extends { result: infer R } ? R : never;

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

export interface LiveClientOptions {
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
   * Async token provider, re-invoked per socket connect and per mutation.
   * Sockets carry it as a `?token=` query param (browsers cannot set WS
   * headers — use short-lived rotating tokens); mutations as a Bearer header.
   */
  authToken?: () => string | undefined | Promise<string | undefined>;

  /** App-level `{event:'ping'}` keepalive cadence (default 30 000 ms; CF answers without waking the DO). */
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
  /** Issuing-identity provider; stamped on enqueue, re-checked before replay. */
  identity?: () => string | null | undefined;
  /** Cross-tab coordination via BroadcastChannel (one shared socket per app). */
  crossTab?: boolean | CrossTabOptions;
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
 * `load()` MUST return records in append (FIFO) order.
 */
export interface MutationStore {
  append(record: PersistedMutation): Promise<void>;
  load(): Promise<PersistedMutation[]>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
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
   * Issuing-identity fingerprint at enqueue (`null` = signed out). Replay is
   * identity-gated when {@link LiveClientOptions.identity} is set. Absent =
   * ambient.
   */
  identity?: string | null;
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
  /** Channel name shared by every tab of the app. Default `'velajs-live'`. */
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
}
