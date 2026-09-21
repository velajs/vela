import {
  LIVE_PROTOCOL,
  WebSocketSendGate,
  MAX_LIVE_FRAME_BYTES,
  MAX_PRESENCE_METADATA_BYTES,
  encodeLiveEnvelope,
  isServerLiveFrame,
  readLiveEnvelope,
} from '@velajs/live-protocol';
import type { WebSocketSendPolicy, ClientLiveFrame } from '@velajs/live-protocol';
import { VelaLiveError } from './errors';
import { applyServerFrame } from './frame-reducer';
import { nextReconnectDelay, resetReconnect } from './reconnect';
import type { ReconnectState } from './reconnect';
import { reportSchemaError, notify } from './subscription';
import type { SubscriptionState } from './subscription';
import type { ConnectionStatus, ReconnectOptions, WebSocketFactory } from './types';

const OPEN = 1;
const MAX_SOCKET_TICKET_BYTES = 8 * 1024;
// `$`-prefixed envelopes are framework-reserved. Cloudflare answers this pair
// without waking a hibernated Durable Object; the shared dispatcher answers it
// for every other Vela WebSocket transport.
const HEARTBEAT_PING = '{"event":"$ping"}';
const HEARTBEAT_PONG = '{"event":"$pong"}';
const FORBIDDEN_WEBSOCKET_CREDENTIAL_PARAMS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'jwt',
  'token',
]);

export interface ConnectionDeps {
  makeSocket: WebSocketFactory;
  socketTicket?: () => string | undefined | Promise<string | undefined>;
  heartbeatIntervalMs: number;
  reconnect?: ReconnectOptions;
  sendPolicy?: WebSocketSendPolicy;
  onStatusChange: () => void;
  /**
   * Called after every applied server frame that advanced the authoritative
   * base or watermark (data/delta/resume/settled) — never on error/resubscribe.
   * The cross-tab leader wires this to relay `serverBase` + cursor/epoch to
   * follower tabs. Optional/additive.
   */
  onServerFrameApplied?: (state: SubscriptionState) => void;
}

/**
 * One socket per room (vela's node transport auto-joins the `:id` route
 * param's room; Cloudflare is one-DO≈one-room), multiplexing every live
 * subscription for that room. Owns: connect/reconnect (decorrelated jitter),
 * resubscribe-with-cursor on open, app-level ping keepalive (self-rescheduling
 * setTimeout — never setInterval), an inbound-frame watchdog for half-open
 * sockets, and `$live` frame routing into the pure frame reducer.
 */
export class RoomConnection {
  status: ConnectionStatus = 'idle';
  #sendGate: WebSocketSendGate;
  private socket?: ReturnType<WebSocketFactory>;
  private readonly bySub = new Map<string, SubscriptionState>();
  private readonly reconnectState: ReconnectState = {};
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private lastFrameAt = 0;
  private heartbeatAcknowledged = false;
  private closedByUser = false;
  private generation = 0;

  constructor(
    private readonly url: string,
    private readonly deps: ConnectionDeps,
  ) {
    assertSafeWebSocketUrl(url);
    this.#sendGate = new WebSocketSendGate(deps.sendPolicy);
  }

  register(state: SubscriptionState): void {
    this.bySub.set(state.sub, state);
    if (this.socket?.readyState === OPEN) {
      this.sendSub(state);
    } else {
      this.ensureConnected();
    }
  }

  unregister(state: SubscriptionState): void {
    this.bySub.delete(state.sub);
    this.sendFrame({ t: 'unsub', sub: state.sub });
  }

  sendPresence(room: string, meta?: unknown): void {
    if (jsonByteLength(meta ?? null) > MAX_PRESENCE_METADATA_BYTES) {
      throw new VelaLiveError(
        'PRESENCE_METADATA_TOO_LARGE',
        `presence metadata exceeds ${MAX_PRESENCE_METADATA_BYTES} bytes`,
      );
    }
    this.ensureConnected();
    this.sendFrame({ t: 'presence', room, meta });
  }

  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    this.socket?.close(1000, 'client closed');
    this.socket = undefined;
    this.setStatus('closed');
  }

  private ensureConnected(): void {
    if (this.closedByUser) return;
    if (this.socket && this.socket.readyState <= OPEN) return; // CONNECTING or OPEN
    void this.connect();
  }

  private async connect(): Promise<void> {
    this.setStatus('connecting');
    const generation = ++this.generation;

    let ticket: string | undefined;
    try {
      ticket = await this.deps.socketTicket?.();
    } catch {
      // A failing ticket provider is treated as a connection failure: back off
      // and retry — the next attempt re-invokes it (rotation-friendly).
      if (generation === this.generation) this.scheduleReconnect();
      return;
    }
    if (generation !== this.generation || this.closedByUser) return;

    let url: string;
    try {
      url = socketUrlWithTicket(this.url, ticket);
    } catch {
      // Invalid tickets never reach the URL or the WebSocket implementation.
      // Retry through the provider so a rotated ticket can recover naturally.
      this.scheduleReconnect();
      return;
    }
    let socket: ReturnType<WebSocketFactory>;
    try {
      socket = this.deps.makeSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.#sendGate = new WebSocketSendGate(this.deps.sendPolicy);

    socket.onopen = () => {
      if (generation !== this.generation || this.socket !== socket) return;
      // A reconnect gets a fresh liveness window; never carry the previous
      // socket's silence into this attempt.
      this.lastFrameAt = Date.now();
      this.heartbeatAcknowledged = false;
      resetReconnect(this.reconnectState);
      this.setStatus('connected');
      // Resubscribe everything with resume watermarks — the server answers
      // each with data (re-run), resume (untouched), or a cold snapshot.
      for (const state of this.bySub.values()) this.sendSub(state);
      this.scheduleHeartbeat(socket, generation);
    };

    socket.onmessage = (event) => {
      // A late frame from a superseded socket must not keep the current socket
      // alive. Any frame from the current one does count, including binary,
      // malformed JSON, gateway events, and the non-live pong envelope.
      if (generation !== this.generation || this.socket !== socket) return;
      this.lastFrameAt = Date.now();
      if (event.data === HEARTBEAT_PONG) this.heartbeatAcknowledged = true;
      if (typeof event.data !== 'string') return;
      this.handleMessage(event.data);
    };

    socket.onclose = () => {
      this.disconnect(socket, generation);
    };

    socket.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  private handleMessage(raw: string): void {
    if (new TextEncoder().encode(raw).byteLength > MAX_LIVE_FRAME_BYTES) {
      this.socket?.close(1009, 'frame too large');
      return;
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return;
    }
    const frame = readLiveEnvelope(envelope);
    if (frame === undefined || !isServerLiveFrame(frame)) return; // classic gateway events / pong / unknown frames

    const sub = 'sub' in frame ? frame.sub : undefined;
    const state = sub === undefined ? undefined : this.bySub.get(sub);
    if (!state) return;

    const effect = applyServerFrame(state, frame);
    switch (effect) {
      case 'notify':
        notify(state);
        break;
      case 'invalid':
        reportSchemaError(state);
        return;
      case 'error':
        if (frame.t === 'error') {
          for (const callback of state.errorCallbacks) {
            callback({ code: frame.code, message: frame.message, fatal: frame.fatal });
          }
        }
        return;
      case 'resubscribe':
        // Unusable cache (epoch fork mid-delta / unmergeable delta): start
        // cold. Same wire id ⇒ unsub first so the server replaces the record.
        state.hasBase = false;
        state.serverBase = undefined;
        state.serverCursor = undefined;
        state.serverEpoch = undefined;
        this.sendFrame({ t: 'unsub', sub: state.sub });
        this.sendSub(state);
        return;
      case 'none':
        break;
    }

    // The authoritative base/watermark may have advanced (data/delta/resume/
    // settled) even when the displayed value didn't change — relay it so
    // follower tabs both render and keep their optimism cursor-gated.
    if (
      frame.t === 'data' ||
      frame.t === 'delta' ||
      frame.t === 'resume' ||
      frame.t === 'settled'
    ) {
      this.deps.onServerFrameApplied?.(state);
    }
  }

  private sendSub(state: SubscriptionState): void {
    const frame: ClientLiveFrame = {
      t: 'sub',
      sub: state.sub,
      query: state.query,
      ...(state.args === undefined ? {} : { args: state.args }),
      ...(state.serverCursor !== undefined && state.serverEpoch !== undefined
        ? { sinceCursor: state.serverCursor, sinceEpoch: state.serverEpoch }
        : {}),
      ...(state.key === undefined ? {} : { key: state.key }),
      v: LIVE_PROTOCOL,
    };
    this.sendFrame(frame);
  }

  private sendFrame(frame: ClientLiveFrame): void {
    if (this.socket?.readyState !== OPEN) return; // onopen resends subscriptions
    try {
      const encoded = encodeLiveEnvelope(frame);
      if (new TextEncoder().encode(encoded).byteLength > MAX_LIVE_FRAME_BYTES) {
        this.socket.close(1009, 'frame too large');
        return;
      }
      this.#sendGate.trySend(this.socket, encoded, MAX_LIVE_FRAME_BYTES);
    } catch {
      // socket died between the readyState check and send — onclose recovers
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = nextReconnectDelay(
      this.reconnectState,
      this.deps.reconnect?.baseMs,
      this.deps.reconnect?.capMs,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private scheduleHeartbeat(socket: ReturnType<WebSocketFactory>, generation: number): void {
    const intervalMs = this.deps.heartbeatIntervalMs;
    if (this.heartbeatTimer || intervalMs <= 0) return;
    const tick = () => {
      this.heartbeatTimer = undefined;
      if (generation !== this.generation || this.socket !== socket || socket.readyState !== OPEN) {
        return;
      }

      // `readyState === OPEN` does not prove the path is live: a swallowed RST
      // or stuck proxy can leave a socket half-open indefinitely. Activate only
      // after this peer has answered `$ping`, preserving older-server support;
      // once active, any inbound frame refreshes the liveness window.
      if (this.heartbeatAcknowledged && Date.now() - this.lastFrameAt > intervalMs * 2.5) {
        try {
          socket.close();
        } catch {
          // A broken implementation may throw while closing. The explicit
          // disconnect below still moves through the normal reconnect path.
        }
        this.disconnect(socket, generation);
        return;
      }

      try {
        this.#sendGate.trySend(socket, HEARTBEAT_PING, MAX_LIVE_FRAME_BYTES);
      } catch {
        // Keep checking liveness even if a broken socket throws without
        // emitting close; the watchdog will recycle it on a later tick.
      }
      this.heartbeatTimer = setTimeout(tick, intervalMs);
    };
    this.heartbeatTimer = setTimeout(tick, intervalMs);
  }

  private disconnect(socket: ReturnType<WebSocketFactory>, generation: number): void {
    if (generation !== this.generation || this.socket !== socket) return;
    this.clearTimers();
    this.socket = undefined;
    if (this.closedByUser) return;
    this.setStatus('offline');
    this.scheduleReconnect();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.deps.onStatusChange();
  }
}

const jsonByteLength = (value: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? 'null').byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const socketUrlWithTicket = (base: string, ticket: string | undefined): string => {
  const url = assertSafeWebSocketUrl(base);
  if (ticket === undefined) return url.toString();
  if (
    ticket.length === 0 ||
    !/^[\x21-\x7e]+$/.test(ticket) ||
    new TextEncoder().encode(ticket).byteLength > MAX_SOCKET_TICKET_BYTES
  ) {
    throw new Error('socket ticket must be a non-empty bounded ASCII token');
  }
  url.searchParams.set('ticket', ticket);
  return url.toString();
};

const assertSafeWebSocketUrl = (value: string): URL => {
  const url = new URL(value);
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.username || url.password) {
    throw new Error('WebSocket URL must use ws/wss and must not contain credentials');
  }
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (normalized === 'ticket' || FORBIDDEN_WEBSOCKET_CREDENTIAL_PARAMS.has(normalized)) {
      throw new Error('WebSocket credentials must come from the socketTicket provider');
    }
  }
  return url;
};
