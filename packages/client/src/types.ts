import type { CommitStamp } from './optimistic';

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

// ---- designed-but-deferred seams (v1 no-ops) ----

/** Durable offline write outbox seam — not implemented in v1 (mutations are plain HTTP). */
export interface OutboxSink {
  enqueue(path: string, body: unknown, options?: MutateOptions): Promise<void>;
  onCommit?(stamp: CommitStamp): void;
}

/** Durable read-cache seam (IndexedDB, …) — in-memory only in v1. */
export interface ReadCacheAdapter {
  load(key: string): Promise<{ value: unknown; cursor?: number; epoch?: string } | undefined>;
  persist(key: string, value: unknown, cursor?: number, epoch?: string): Promise<void>;
}
