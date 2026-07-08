import { COMMIT_CURSOR_HEADER, COMMIT_EPOCH_HEADER } from '@velajs/live-protocol';
import { RoomConnection } from './connection';
import { toMutationError } from './errors';
import { applyOptimisticLayer } from './optimistic';
import type { CommitStamp, LayerHandle } from './optimistic';
import { argsKeyOf, createSubscriptionState, notify, refold, subscriptionKey } from './subscription';
import type { SubscriptionState } from './subscription';
import type {
  ArgsOf,
  ConnectionStatus,
  HydrationEntry,
  LiveClientOptions,
  LiveContract,
  LiveStore,
  MutateOptions,
  ResultOf,
  SubscribeOptions,
  Unsubscribe,
} from './types';

const DEFAULT_WS_PATH = '/rooms/:room/ws';
const DEFAULT_ROOM = 'default';
const DEFAULT_HEARTBEAT_MS = 30_000;

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
 */
export class LiveClient<C extends LiveContract = LiveContract> {
  private readonly registry = new Map<string, SubscriptionState>();
  private readonly connections = new Map<string, RoomConnection>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private lastStatus: ConnectionStatus = 'idle';

  constructor(private readonly options: LiveClientOptions) {}

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

    if (fresh) this.connectionFor(room).register(state);

    return () => {
      state.callbacks.delete(cb);
      if (subscribeOptions?.onError) state.errorCallbacks.delete(subscribeOptions.onError);
      if (state.callbacks.size === 0) {
        this.registry.delete(key);
        this.connectionFor(room).unregister(state);
      }
    };
  }

  /** The current cached (folded) value — referentially stable between notifications. */
  peek<Q extends keyof C & string>(query: Q, args: ArgsOf<C, Q>, room?: string): ResultOf<C, Q> | undefined {
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
   */
  async mutate<R = unknown>(path: string, body?: unknown, mutateOptions?: MutateOptions): Promise<R> {
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

    try {
      const doFetch = this.options.fetch ?? fetch;
      const token = await this.options.authToken?.();
      const headers: Record<string, string> = {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...mutateOptions?.headers,
      };
      const response = await doFetch(new URL(path, this.options.url).toString(), {
        method: mutateOptions?.method ?? 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw await toMutationError(response);

      const stamp = readCommitStamp(response);
      for (const { state, handle } of handles) {
        // confirm() reports true when the covering frame already arrived —
        // drop is immediate, re-fold now.
        if (handle.confirm(stamp) && refold(state)) notify(state);
      }

      if (response.status === 204 || response.status === 205) return undefined as R;
      try {
        return (await response.json()) as R;
      } catch {
        return undefined as R;
      }
    } catch (error) {
      for (const { state, handle } of handles) {
        if (handle.rollback() && refold(state)) notify(state);
      }
      throw error;
    }
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
    for (const connection of this.connections.values()) connection.close();
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
          if (status === this.lastStatus) return;
          this.lastStatus = status;
          for (const listener of this.statusListeners) listener(status);
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
