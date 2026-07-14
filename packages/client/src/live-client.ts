import { COMMIT_CURSOR_HEADER, COMMIT_EPOCH_HEADER } from '@velajs/live-protocol';
import { ClientQueryStore } from './client-query';
import { RoomConnection } from './connection';
import { CrossTabCoordinator } from './cross-tab';
import type { WantSpec } from './cross-tab';
import { isVelaLiveError, toMutationError, VelaLiveError } from './errors';
import { MutationQueue } from './mutation-queue';
import type { QueuedMutation } from './mutation-queue';
import { applyOptimisticLayer, dropConfirmedLayers } from './optimistic';
import type { CommitStamp, LayerHandle } from './optimistic';
import {
  argsKeyOf,
  createSubscriptionState,
  notify,
  refold,
  subscriptionKey,
} from './subscription';
import type { SubscriptionState } from './subscription';
import type {
  ArgsOf,
  ClientQueryRef,
  ConnectionStatus,
  CrossTabOptions,
  HydrationEntry,
  LiveClientOptions,
  LiveContract,
  LiveStore,
  MutateOptions,
  MutationSettledEvent,
  MutationVerdict,
  OfflineQueueOptions,
  ResultOf,
  SubscribeOptions,
  Unsubscribe,
} from './types';

const DEFAULT_WS_PATH = '/rooms/:room/ws';
const DEFAULT_ROOM = 'default';
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_QUEUE = 1000;

/**
 * The framework-neutral Vela live client.
 *
 * ```ts
 * const client = new LiveClient<AppLive>({ url: 'https://api.example.com' });
 * const stop = client.subscribe('todos.list', { listId: 'l1' }, (todos) => render(todos));
 * await client.mutate('/todos', { text: 'hi' }, {
 *   optimistic: { query: 'todos.list', args: { listId: 'l1' }, apply: (t = []) => [...t, temp] },
 * });
 * ```
 *
 * Identical `(query, args, room)` subscriptions share one wire registration;
 * reconnects resubscribe with the last cursor+epoch so untouched
 * subscriptions resume without a re-run; optimistic updates are rebaseable
 * layers gated on the mutation's `Vela-Commit-Cursor` response header.
 *
 * Optional infrastructure (all off by default): an offline mutation queue
 * (`offline`, `mutationStore`) that survives reloads and replays FIFO on
 * reconnect; cross-tab coordination (`crossTab`) that elects one leader tab to
 * own the sockets while followers render relayed snapshots; and a local-only
 * client-query store.
 */
export class LiveClient<C extends LiveContract = LiveContract> {
  private readonly registry = new Map<string, SubscriptionState>();
  private readonly connections = new Map<string, RoomConnection>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private lastStatus: ConnectionStatus = 'idle';
  private everConnected = false;

  private readonly clientQueries = new ClientQueryStore();

  // --- offline mutation queue ---
  private readonly queue?: MutationQueue;
  private readonly settledListeners = new Set<(event: MutationSettledEvent) => void>();
  private readonly pendingListeners = new Set<() => void>();
  private offlineQueueBeforeFirstConnect = false;
  private flushing = false;

  // --- cross-tab coordination ---
  private readonly coordinator?: CrossTabCoordinator;
  /** Leader-side shadow subscriptions serving follower-only queries. */
  private readonly relayStates = new Map<string, SubscriptionState>();
  /** Leader-side: subscription key → set of follower tab ids wanting it. */
  private readonly wanters = new Map<string, Set<string>>();

  constructor(private readonly options: LiveClientOptions) {
    if (options.offline) {
      const config: OfflineQueueOptions =
        typeof options.offline === 'object' ? options.offline : {};
      this.offlineQueueBeforeFirstConnect = config.queueBeforeFirstConnect ?? false;
      const onError = config.onError ?? defaultQueueOnError;
      this.queue = new MutationQueue({
        maxItems: config.maxItems ?? DEFAULT_MAX_QUEUE,
        version: options.persistenceVersion,
        store: options.mutationStore,
        onError,
        onSize: () => this.notifyPending(),
        onEvict: (entry) => this.emitSettled(entry, 'dropped', 'OFFLINE_QUEUE_OVERFLOW'),
      });
      void this.queue
        .hydrate()
        .then(() => this.flush())
        .catch(() => {});
    }

    if (options.crossTab) {
      const config: CrossTabOptions | undefined =
        typeof options.crossTab === 'object' ? options.crossTab : undefined;
      this.coordinator = new CrossTabCoordinator(config, {
        onBecomeLeader: this.onBecomeLeader,
        onResignLeader: this.onResignLeader,
        onResync: this.onResync,
        onFrame: this.onFrame,
        onFrameError: this.onFrameError,
        onWant: this.onWant,
        onUnwant: this.onUnwant,
        onTabGone: this.onTabGone,
      });
      this.coordinator.start();
    }
  }

  subscribe<Q extends keyof C & string>(
    query: Q,
    args: ArgsOf<C, Q>,
    callback: (value: ResultOf<C, Q> | undefined) => void,
    subscribeOptions?: SubscribeOptions,
  ): Unsubscribe {
    const room = subscribeOptions?.room ?? this.options.defaultRoom ?? DEFAULT_ROOM;
    const key = subscriptionKey(query, argsKeyOf(args), room);

    let state = this.registry.get(key);
    let fresh = false;
    if (!state) {
      state = createSubscriptionState(query, args, room, subscribeOptions?.key);
      this.registry.set(key, state);
      fresh = true;
    }

    const cb = callback as (value: unknown) => void;
    state.callbacks.add(cb);
    if (subscribeOptions?.onError) state.errorCallbacks.add(subscribeOptions.onError);

    // Late joiners get the cached value synchronously (lunora parity).
    if (state.hasBase || state.layers.length > 0) cb(state.lastValue);

    if (fresh) this.attachTransport(state, key);

    return () => {
      state.callbacks.delete(cb);
      if (subscribeOptions?.onError) state.errorCallbacks.delete(subscribeOptions.onError);
      if (state.callbacks.size === 0) {
        this.registry.delete(key);
        this.detachTransport(state, key);
      }
    };
  }

  /** The current cached (folded) value — referentially stable between notifications. */
  peek<Q extends keyof C & string>(
    query: Q,
    args: ArgsOf<C, Q>,
    room?: string,
  ): ResultOf<C, Q> | undefined {
    const state = this.registry.get(
      subscriptionKey(query, argsKeyOf(args), room ?? this.options.defaultRoom ?? DEFAULT_ROOM),
    );
    return state?.lastValue as ResultOf<C, Q> | undefined;
  }

  /**
   * Fire an HTTP mutation. Optimistic targets paint immediately; the layer
   * drops when a subscription frame's cursor passes the response's
   * `Vela-Commit-Cursor` (missing header ⇒ one-shot optimism); a rejection
   * rolls back. Resolves with the parsed JSON body (undefined when empty).
   *
   * With an offline queue configured, a mutate issued while proven offline is
   * enqueued (durable, replayed on reconnect) instead of fetched now, and a
   * transport error on a direct attempt falls back to the queue rather than
   * rejecting; a coded HTTP error still rolls back and rejects.
   */
  async mutate<R = unknown>(
    path: string,
    body?: unknown,
    mutateOptions?: MutateOptions,
  ): Promise<R> {
    const handles: Array<{ state: SubscriptionState; handle: LayerHandle }> = [];
    const paint = (state: SubscriptionState, transform: (current: unknown) => unknown): void => {
      const handle = applyOptimisticLayer(state, transform);
      handles.push({ state, handle });
      if (refold(state)) notify(state);
    };

    if (mutateOptions?.optimistic) {
      const target = mutateOptions.optimistic;
      const state = this.registry.get(
        subscriptionKey(
          target.query,
          argsKeyOf(target.args),
          target.room ?? mutateOptions.room ?? this.options.defaultRoom ?? DEFAULT_ROOM,
        ),
      );
      // No live subscription for the target ⇒ nothing displays it: no-op.
      if (state) paint(state, target.apply as (current: unknown) => unknown);
    }
    if (mutateOptions?.optimisticUpdate) {
      mutateOptions.optimisticUpdate(this.makeStore(mutateOptions, paint));
    }

    const queue = this.queue;
    const forceDirect = mutateOptions?.offline === false;

    // Eager offline queueing: proven offline (or offline-first before connect).
    if (queue && !forceDirect && this.shouldQueueEagerly()) {
      return this.enqueueMutation<R>(path, body, mutateOptions, handles);
    }

    let encodedBody: string | undefined;
    try {
      encodedBody = body === undefined ? undefined : JSON.stringify(body);
    } catch (error) {
      this.rollbackAll(handles);
      throw error;
    }

    try {
      const response = await this.sendMutation(
        path,
        encodedBody,
        mutateOptions?.method,
        mutateOptions?.headers,
      );
      if (!response.ok) throw await toMutationError(response);

      const stamp = readCommitStamp(response);
      for (const { state, handle } of handles) {
        if (handle.confirm(stamp) && refold(state)) notify(state);
      }
      const value = (await parseBody(response)) as R;
      // Opportunistically drain any writes that queued while we were offline.
      if (queue && queue.size > 0) void this.flush();
      return value;
    } catch (error) {
      // A transport/network failure with a queue configured is not terminal —
      // enqueue as a durable fallback and keep the optimistic layers pending.
      if (queue && !forceDirect && !isVelaLiveError(error)) {
        return this.enqueueMutation<R>(path, body, mutateOptions, handles);
      }
      this.rollbackAll(handles);
      throw error;
    }
  }

  /** Replay every durable queued write now (best-effort; e.g. from a `navigator.onLine` handler). */
  async flush(): Promise<void> {
    const queue = this.queue;
    if (!queue || this.flushing) return;
    this.flushing = true;
    try {
      await this.flushOnce(queue);
    } finally {
      this.flushing = false;
    }
  }

  /** Number of writes waiting in the offline queue. */
  pendingMutations(): number {
    return this.queue?.size ?? 0;
  }

  /** Observe terminal verdicts — the only channel for hydrated (awaiter-less) writes. */
  onMutationSettled(callback: (event: MutationSettledEvent) => void): Unsubscribe {
    this.settledListeners.add(callback);
    return () => this.settledListeners.delete(callback);
  }

  /** Observe changes to the pending-mutation count (drives `usePendingMutations`). */
  onPendingChange(listener: () => void): Unsubscribe {
    this.pendingListeners.add(listener);
    return () => this.pendingListeners.delete(listener);
  }

  // ---- client-query store ----

  getClientQuery<T>(ref: ClientQueryRef<T>): T {
    return this.clientQueries.get(ref);
  }

  setClientQuery<T>(ref: ClientQueryRef<T>, value: T): void {
    this.clientQueries.set(ref, value);
  }

  subscribeClientQuery<T>(ref: ClientQueryRef<T>, listener: () => void): Unsubscribe {
    return this.clientQueries.subscribe(ref, listener);
  }

  /** True when this tab owns the live sockets (always true when crossTab is disabled). */
  isLeader(): boolean {
    return this.coordinator ? this.coordinator.isLeader() : true;
  }

  /** Presence heartbeat for a room (see `@velajs/client/presence` for the managed preset). */
  presenceBeat(room: string, meta?: unknown): void {
    this.connectionFor(room).sendPresence(room, meta);
  }

  /** Seed subscription state before connecting (SSR hydration). Subscribes then resume from the seeded cursor. */
  hydrate(entries: HydrationEntry[]): void {
    for (const entry of entries) {
      const room = entry.room ?? this.options.defaultRoom ?? DEFAULT_ROOM;
      const key = subscriptionKey(entry.query, argsKeyOf(entry.args), room);
      if (this.registry.has(key)) continue;
      const state = createSubscriptionState(entry.query, entry.args, room);
      state.serverBase = entry.value;
      state.hasBase = true;
      state.lastValue = entry.value;
      state.serverCursor = entry.cursor;
      state.serverEpoch = entry.epoch;
      this.registry.set(key, state);
    }
  }

  connectionStatus(): ConnectionStatus {
    const statuses = [...this.connections.values()].map((connection) => connection.status);
    if (statuses.includes('connected')) return 'connected';
    if (statuses.includes('connecting')) return 'connecting';
    if (statuses.includes('offline')) return 'offline';
    if (statuses.length > 0 && statuses.every((status) => status === 'closed')) return 'closed';
    return 'idle';
  }

  onConnectionStatus(listener: (status: ConnectionStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  close(): void {
    this.coordinator?.stop();
    this.queue?.clear();
    for (const connection of this.connections.values()) connection.close();
  }

  // ---- transport role selection ----

  private attachTransport(state: SubscriptionState, key: string): void {
    if (this.isLeader()) {
      // A local subscribe supersedes any relay shadow serving this key.
      const shadow = this.relayStates.get(key);
      if (shadow) {
        this.connectionFor(shadow.room).unregister(shadow);
        this.relayStates.delete(key);
      }
      this.connectionFor(state.room).register(state);
    } else {
      this.coordinator?.want(key, specFor(state));
    }
  }

  private detachTransport(state: SubscriptionState, key: string): void {
    if (this.isLeader()) {
      // Followers may still need this key — keep the socket sub as a relay shadow.
      if ((this.wanters.get(key)?.size ?? 0) > 0) {
        this.wireRelayError(state, key);
        this.relayStates.set(key, state);
      } else {
        this.connectionFor(state.room).unregister(state);
      }
    } else {
      this.coordinator?.unwant(key);
    }
  }

  // ---- cross-tab callbacks ----

  private readonly onBecomeLeader = (): void => {
    // Take ownership: register our own subscriptions on their sockets. A
    // resubscribe carries the last relayed cursor/epoch, so the server resumes.
    for (const state of this.registry.values()) {
      this.connectionFor(state.room).register(state);
    }
  };

  private readonly onResignLeader = (): void => {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.relayStates.clear();
    this.wanters.clear();
    // Re-declare our own subscriptions as a follower.
    for (const [key, state] of this.registry) this.coordinator?.want(key, specFor(state));
  };

  private readonly onResync = (): void => {
    if (this.isLeader()) return;
    for (const [key, state] of this.registry) this.coordinator?.want(key, specFor(state));
  };

  private readonly onFrame = (
    key: string,
    value: unknown,
    cursor: number | undefined,
    epoch: string | undefined,
  ): void => {
    const state = this.registry.get(key);
    if (!state) return;
    state.serverBase = value;
    state.hasBase = true;
    if (cursor !== undefined) state.serverCursor = cursor;
    if (epoch !== undefined) state.serverEpoch = epoch;
    dropConfirmedLayers(state, cursor, epoch);
    refold(state);
    notify(state);
  };

  private readonly onFrameError = (
    key: string,
    error: { code: string; message: string; fatal: boolean },
  ): void => {
    const state = this.registry.get(key);
    if (!state) return;
    for (const callback of state.errorCallbacks) callback(error);
  };

  private readonly onWant = (key: string, spec: WantSpec, fromTab: string): void => {
    let set = this.wanters.get(key);
    if (!set) {
      set = new Set();
      this.wanters.set(key, set);
    }
    set.add(fromTab);

    const existing = this.registry.get(key) ?? this.relayStates.get(key);
    if (existing) {
      // Already served (own sub or shadow) — seed the new wanter with the current value.
      if (existing.hasBase) {
        this.coordinator?.publishFrame(
          key,
          existing.serverBase,
          existing.serverCursor,
          existing.serverEpoch,
        );
      }
      return;
    }

    // Synthesize a shadow subscription sharing the room's socket.
    const shadow = createSubscriptionState(spec.query, spec.args, spec.room, spec.keyField);
    this.wireRelayError(shadow, key);
    this.relayStates.set(key, shadow);
    this.connectionFor(spec.room).register(shadow);
  };

  private readonly onUnwant = (key: string, fromTab: string): void => {
    const set = this.wanters.get(key);
    if (set) {
      set.delete(fromTab);
      if (set.size === 0) this.wanters.delete(key);
    }
    this.gcRelay(key);
  };

  private readonly onTabGone = (tab: string): void => {
    for (const [key, set] of this.wanters) {
      if (set.delete(tab) && set.size === 0) this.wanters.delete(key);
    }
    for (const key of [...this.relayStates.keys()]) this.gcRelay(key);
  };

  private gcRelay(key: string): void {
    const shadow = this.relayStates.get(key);
    if (!shadow) return;
    const wanted = (this.wanters.get(key)?.size ?? 0) > 0;
    const owned = this.registry.has(key);
    if (!wanted && !owned) {
      this.connectionFor(shadow.room).unregister(shadow);
      this.relayStates.delete(key);
    }
  }

  private wireRelayError(state: SubscriptionState, key: string): void {
    state.errorCallbacks.add((error) => {
      if (this.isLeader()) this.coordinator?.publishError(key, error);
    });
  }

  // ---- offline queue plumbing ----

  private shouldQueueEagerly(): boolean {
    // A follower has no socket of its own to judge "offline"; it fetches
    // directly and relies on the transport-error fallback.
    if (this.coordinator !== undefined && !this.coordinator.isLeader()) return false;
    const status = this.connectionStatus();
    if (status === 'offline' || status === 'closed') return true;
    return this.offlineQueueBeforeFirstConnect && !this.everConnected;
  }

  private enqueueMutation<R>(
    path: string,
    body: unknown,
    mutateOptions: MutateOptions | undefined,
    handles: Array<{ state: SubscriptionState; handle: LayerHandle }>,
  ): Promise<R> {
    const queue = this.queue;
    if (!queue) {
      return Promise.reject(new VelaLiveError('OFFLINE_DISABLED', 'no offline queue configured'));
    }
    return new Promise<R>((resolve, reject) => {
      queue.enqueue({
        path,
        body,
        method: mutateOptions?.method,
        headers: mutateOptions?.headers,
        room: mutateOptions?.room,
        identity: this.options.identity ? (this.options.identity() ?? null) : undefined,
        precondition: mutateOptions?.precondition,
        hadAwaiter: true,
        resolve: (value) => resolve(value as R),
        reject: (error) => {
          this.rollbackAll(handles);
          reject(error);
        },
        onCommit: (stamp) => {
          for (const { state, handle } of handles) {
            if (handle.confirm(stamp) && refold(state)) notify(state);
          }
        },
      });
    });
  }

  private async flushOnce(queue: MutationQueue): Promise<void> {
    // 1. Precondition conflicts — a queued write whose assumed value changed.
    for (const entry of queue.drainConflict()) {
      queue.forget(entry.id);
      this.emitSettled(entry, 'dropped', 'OFFLINE_PRECONDITION_FAILED');
      entry.reject(
        new VelaLiveError('OFFLINE_PRECONDITION_FAILED', 'queued mutation precondition failed'),
      );
    }

    // 2. Drain the remaining writes in FIFO order.
    const pending = queue.drain();
    if (pending.length === 0) return;

    // 3. Identity gate (only when an identity provider is configured).
    const identityGated = this.options.identity !== undefined;
    const currentIdentity = this.options.identity?.() ?? null;
    const runnable: QueuedMutation[] = [];
    for (const entry of pending) {
      if (identityGated && entry.identity !== undefined && entry.identity !== currentIdentity) {
        queue.forget(entry.id);
        this.emitSettled(entry, 'dropped', 'OFFLINE_IDENTITY_MISMATCH');
        entry.reject(
          new VelaLiveError(
            'OFFLINE_IDENTITY_MISMATCH',
            'queued mutation identity no longer matches',
          ),
        );
      } else {
        runnable.push(entry);
      }
    }

    // 4 + 5. Sequential FIFO replay (Vela has no batch endpoint).
    for (const [index, entry] of runnable.entries()) {
      let encodedBody: string | undefined;
      try {
        encodedBody = entry.body === undefined ? undefined : JSON.stringify(entry.body);
      } catch {
        // Deterministic failure — reject terminally, never requeue (no loop).
        queue.forget(entry.id);
        this.emitSettled(entry, 'rejected', 'OFFLINE_UNSERIALIZABLE');
        entry.reject(
          new VelaLiveError('OFFLINE_UNSERIALIZABLE', 'queued mutation body is not serializable'),
        );
        continue;
      }

      let response: Response;
      try {
        response = await this.sendMutation(entry.path, encodedBody, entry.method, entry.headers);
      } catch {
        // Transport error — keep the write durable, requeue in order and STOP.
        queue.requeue([entry, ...runnable.slice(index + 1)]);
        return;
      }

      if (!response.ok) {
        const error = await toMutationError(response);
        queue.forget(entry.id);
        this.emitSettled(entry, 'rejected', error.code);
        entry.reject(error);
        continue;
      }

      const stamp = readCommitStamp(response);
      entry.onCommit?.(stamp);
      const value = await parseBody(response);
      queue.forget(entry.id);
      this.emitSettled(entry, 'committed');
      entry.resolve(value);
    }
  }

  private emitSettled(entry: QueuedMutation, status: MutationVerdict, code?: string): void {
    const event: MutationSettledEvent = {
      path: entry.path,
      status,
      ...(code === undefined ? {} : { code }),
      hadAwaiter: entry.hadAwaiter,
    };
    for (const listener of [...this.settledListeners]) {
      try {
        listener(event);
      } catch {
        // A misbehaving observer must not stall the flush loop.
      }
    }
  }

  private notifyPending(): void {
    for (const listener of [...this.pendingListeners]) {
      try {
        listener();
      } catch {
        // ignore observer throws
      }
    }
  }

  private rollbackAll(handles: Array<{ state: SubscriptionState; handle: LayerHandle }>): void {
    for (const { state, handle } of handles) {
      if (handle.rollback() && refold(state)) notify(state);
    }
  }

  private async sendMutation(
    path: string,
    encodedBody: string | undefined,
    method: string | undefined,
    extraHeaders: Record<string, string> | undefined,
  ): Promise<Response> {
    const doFetch = this.options.fetch ?? fetch;
    const token = await this.options.authToken?.();
    const headers: Record<string, string> = {
      ...(encodedBody === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...extraHeaders,
    };
    return doFetch(new URL(path, this.options.url).toString(), {
      method: method ?? 'POST',
      headers,
      ...(encodedBody === undefined ? {} : { body: encodedBody }),
    });
  }

  private makeStore(
    mutateOptions: MutateOptions,
    paint: (state: SubscriptionState, transform: (current: unknown) => unknown) => void,
  ): LiveStore {
    const resolve = (query: string, args?: unknown, room?: string) =>
      this.registry.get(
        subscriptionKey(
          query,
          argsKeyOf(args),
          room ?? mutateOptions.room ?? this.options.defaultRoom ?? DEFAULT_ROOM,
        ),
      );
    return {
      get: (query, args, room) => resolve(query, args, room)?.lastValue,
      set: (query, args, next, room) => {
        const state = resolve(query, args, room);
        if (!state) return;
        const transform =
          typeof next === 'function' ? (next as (current: unknown) => unknown) : () => next;
        paint(state, transform);
      },
    };
  }

  private connectionFor(room: string): RoomConnection {
    const wsBase = (this.options.wsUrl ?? this.options.url).replace(/^http/, 'ws');
    const template = this.options.wsPath ?? DEFAULT_WS_PATH;
    const path = template.includes(':room')
      ? template.replace(':room', encodeURIComponent(room))
      : template;
    const url = new URL(path, wsBase).toString();

    let connection = this.connections.get(url);
    if (!connection) {
      connection = new RoomConnection(url, {
        makeSocket:
          this.options.WebSocket ??
          ((socketUrl: string) => {
            const WS = (globalThis as { WebSocket?: new (u: string) => unknown }).WebSocket;
            if (!WS) {
              throw new Error(
                'No WebSocket implementation available — pass one via LiveClientOptions.WebSocket',
              );
            }
            return new WS(socketUrl) as never;
          }),
        authToken: this.options.authToken,
        heartbeatIntervalMs: this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS,
        reconnect: this.options.reconnect,
        onStatusChange: () => {
          const status = this.connectionStatus();
          if (status === 'connected') this.everConnected = true;
          if (status === this.lastStatus) return;
          this.lastStatus = status;
          for (const listener of this.statusListeners) listener(status);
          // Flush trigger: a fresh connection can carry the queued writes.
          if (status === 'connected' && this.queue) void this.flush();
        },
        onServerFrameApplied: (state) => {
          if (this.coordinator === undefined || !this.coordinator.isLeader()) return;
          const key = subscriptionKey(state.query, state.argsKey, state.room);
          this.coordinator.publishFrame(
            key,
            state.serverBase,
            state.serverCursor,
            state.serverEpoch,
          );
        },
      });
      this.connections.set(url, connection);
    }
    return connection;
  }
}

function readCommitStamp(response: Response): CommitStamp | undefined {
  const cursor = response.headers.get(COMMIT_CURSOR_HEADER);
  const epoch = response.headers.get(COMMIT_EPOCH_HEADER);
  if (cursor === null || epoch === null) return undefined;
  const parsed = Number(cursor);
  return Number.isFinite(parsed) ? { cursor: parsed, epoch } : undefined;
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

const specFor = (state: SubscriptionState): WantSpec => ({
  query: state.query,
  args: state.args,
  room: state.room,
  keyField: state.key,
});

const defaultQueueOnError: NonNullable<OfflineQueueOptions['onError']> = (ctx) => {
  (globalThis as { console?: { warn?: (...args: unknown[]) => void } }).console?.warn?.(
    `[velajs/client] offline mutation store ${ctx.operation} failed`,
    ctx.error,
  );
};
