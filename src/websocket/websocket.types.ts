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
  data: TData;
  /** Frame and send `{ event, data }` (optionally correlated by `id`) to this socket. */
  send(event: string, data?: unknown, id?: string): void;
  /** Send an already-serialized string. Escape hatch for custom framing. */
  sendRaw(payload: string): void;
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
}

/** An `ExecutionContext` whose transport is a WebSocket gateway. `switchToWs()` is guaranteed present. */
export interface WsExecutionContext extends ExecutionContext {
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

export interface WebSocketGatewayOptions {
  /** Route path the upgrade is served on (e.g. `/rooms/:id/ws`). */
  path?: string;
  /** Cloudflare Durable Object binding name that hosts this gateway's sockets. */
  binding?: string;
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
