import type { WebSocketSendPolicy, WebSocketSendResult } from '@velajs/live-protocol';
import type { ExecutionContext, WsArgumentsHost } from '../pipeline/types';

export type { WsArgumentsHost };

/** The JSON envelope carried over the raw WebSocket. `id` is an optional client correlation id echoed on the reply. */
export interface WsMessage<T = unknown> {
  id?: string;
  event: string;
  data?: T;
}

/** A handler's structured reply. Returning one frames `{ event, data }` back to the sender. */
export interface WsResponse<T = unknown> {
  event: string;
  data: T;
}

/**
 * A single connected socket, normalized across runtimes. Per-connection state
 * lives in `data`; mutations to `data`/room membership are persisted by
 * `commit()` (on Cloudflare this writes the hibernation attachment).
 */
export interface WsClient<TData = Record<string, unknown>> {
  readonly id: string;
  readonly rooms: ReadonlySet<string>;
  /** Validated inbound/outbound ceiling for this gateway connection. */
  readonly maxFrameBytes?: number;
  data: TData;
  /** Frame and send `{ event, data }` (optionally correlated by `id`) to this socket. */
  send(event: string, data?: unknown, id?: string): void;
  /** Send an already-serialized string. Escape hatch for custom framing. */
  sendRaw(payload: string): void;
  /** Optional explicit local admission result; accepted never means remote delivery. */
  trySendRaw?(payload: string): WebSocketSendResult;
  join(room: string): void | Promise<void>;
  leave(room: string): void | Promise<void>;
  /** Persist `data`/room mutations made during a handler. */
  commit(): void | Promise<void>;
  close(code?: number, reason?: string): void;
  /** The native socket (`WSContext` on node/bun/deno, `WebSocket` in a Cloudflare DO). */
  readonly raw: unknown;
}

/** Fluent broadcast builder. Terminal `.emit()` produces a `BroadcastCommand`. */
export interface BroadcastOperator {
  to(room: string): BroadcastOperator;
  in(room: string): BroadcastOperator;
  except(room: string): BroadcastOperator;
  emit(event: string, data?: unknown): void | Promise<void>;
}

/** The server handle injected via `@WebSocketServer()`. Server-origin broadcasts never exclude anyone. */
export interface WsServer {
  emit(event: string, data?: unknown): void | Promise<void>;
  to(room: string): BroadcastOperator;
  in(room: string): BroadcastOperator;
  except(room: string): BroadcastOperator;
  /** @internal Set by gateway discovery to bound cross-instance commands. */
  setOutboundFrameLimit?(maxFrameBytes: number): void;
}

/** An `ExecutionContext` whose transport is a WebSocket gateway. `switchToWs()` is guaranteed present. */
export interface WsExecutionContext extends ExecutionContext {
  getType(): 'ws';
  getContext(): never;
  getRequest(): never;
  switchToHttp(): never;
  switchToWs(): WsArgumentsHost;
}

// Gateway lifecycle hooks (NestJS parity).
export interface OnGatewayInit {
  afterInit(server: WsServer): void | Promise<void>;
}
export interface OnGatewayConnection {
  handleConnection(client: WsClient): void | Promise<void>;
}
export interface OnGatewayDisconnect {
  handleDisconnect(client: WsClient): void | Promise<void>;
}

/** Canonical, issuer-qualified principal accepted at the WebSocket boundary. */
export interface WebSocketPrincipal {
  issuer: string;
  subject: string;
  principalType: 'user' | 'service';
}

/** Trusted connection identity persisted by WebSocket transports. */
export interface WebSocketUpgradeIdentity {
  principal: WebSocketPrincipal;
  tenantId: string;
  /** Exclusive credential/session expiry in epoch milliseconds. */
  expiresAtMs: number;
}

export interface WebSocketUpgradeAuthenticationContext {
  gatewayPath: string;
  room: string;
  /** Opaque query ticket, removed from the Request before callbacks run. */
  ticket?: string;
}

export interface WebSocketGatewayOptions {
  /** Route path the upgrade is served on (e.g. `/rooms/:id/ws`). */
  path?: string;
  /** Cloudflare Durable Object binding name that hosts this gateway's sockets. */
  binding?: string;
  /**
   * Path parameter used as the room id. Required for every parameterized path
   * so routing remains explicit across transports.
   */
  roomParam?: string;
  /**
   * Browser origins allowed to open the socket. Omitted means same-origin;
   * non-browser clients without an Origin header are allowed. `'*'` is an
   * explicit opt-out.
   */
  allowedOrigins?: '*' | readonly string[];
  /** Optional additional authorization run before authentication/allocation. */
  authorizeUpgrade?: (request: Request) => boolean | Promise<boolean>;
  /**
   * Authenticate an upgrade with a secure cookie or a short-lived socket
   * ticket. Returning anything except a valid trusted identity denies the
   * upgrade. This hook is required for every successful upgrade; omitting it
   * makes the gateway fail closed.
   */
  authenticateUpgrade?: (
    request: Request,
    context: WebSocketUpgradeAuthenticationContext,
  ) => WebSocketUpgradeIdentity | false | Promise<WebSocketUpgradeIdentity | false>;
  /**
   * Per-recipient authorization re-run before server-initiated delivery. Use
   * it for revocation or mutable membership checks; errors fail closed.
   */
  authorizeDelivery?: (client: WsClient) => boolean | Promise<boolean>;
  /** Maximum inbound and outbound frame size in bytes (default 64 KiB). */
  maxFrameBytes?: number;
  /** Connection-local outgoing byte budgets; overload closes with 1013. */
  sendPolicy?: WebSocketSendPolicy;
  /** Maximum active + queued messages per connection (default 64). */
  maxPendingMessages?: number;
  /** Maximum bytes in active + queued messages (default 1 MiB). */
  maxPendingBytes?: number;
}

/** Stored per `@SubscribeMessage` — a flat class-level list, mirroring `@OnEvent`. */
export interface SubscribeMessageMetadata {
  event: string;
  methodName: string;
}

/** Class-level meta written by `@ReservedWsEvent(event)`. */
export interface ReservedWsEventMetadata {
  /** The reserved (`$`-prefixed) envelope event this provider handles. */
  event: string;
}

/**
 * A provider claiming a reserved (`$`-prefixed) envelope event across EVERY
 * gateway path. Discovered by `WsDispatcher` at bootstrap via the
 * `@ReservedWsEvent` decorator; inbound frames for the event route here
 * (after app-wide guards), never to gateways. `handleSocketClose` fires for
 * every closing socket so the handler can drop per-connection state.
 */
export interface ReservedWsEventHandler {
  handleReservedEvent(path: string, client: WsClient, message: WsMessage): void | Promise<void>;
  handleSocketClose?(path: string, client: WsClient): void | Promise<void>;
}

/**
 * A fully serializable broadcast instruction. Crosses isolate / Durable-Object /
 * Redis boundaries as JSON, so every sync driver speaks the same command.
 */
export interface BroadcastCommand {
  /** Target rooms. An empty array means GLOBAL (every connection). */
  rooms: string[];
  exceptRooms?: string[];
  exceptIds?: string[];
  /** The exact bytes written to each socket: `JSON.stringify({ event, data })`. */
  frame: string;
  /** Origin instance/DO id — lets pub/sub drivers drop their own echo. */
  origin?: string;
}
