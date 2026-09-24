import type { WebSocketSendPolicy, WebSocketSendResult } from '@velajs/live-protocol';
import type { Type } from '../container/types';
import type { VelaEnv } from '../env';
import type { ExecutionContext, WsArgumentsHost } from '../pipeline/types';
import type { SyncDriver } from './ws-sync';

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
  /**
   * The route path of the gateway this socket connected through. A `Gateways`
   * push reaches only its gateway's sockets, so a socket without a path
   * receives none.
   */
  readonly path?: string;
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

/**
 * Authenticates a WebSocket upgrade with a secure cookie or a short-lived
 * socket ticket, before any socket or Durable Object is allocated. Returning
 * anything except a valid trusted identity, or throwing, denies the upgrade.
 *
 * Gateways name the class in `@WebSocketGateway({ authenticator })`. Each
 * application resolves it once, through dependency injection, from the module
 * that declares the gateway: a registered provider is reused, and an
 * unregistered class is constructed with what that module can inject. That
 * instance serves every upgrade, so a request-scoped authenticator, declared
 * or through a request-scoped dependency, is rejected as misconfigured.
 */
export interface UpgradeAuthenticator {
  authenticate(
    request: Request,
    context: WebSocketUpgradeAuthenticationContext,
  ): WebSocketUpgradeIdentity | false | Promise<WebSocketUpgradeIdentity | false>;
}

export interface WebSocketGatewayOptions {
  /** Route path the upgrade is served on (e.g. `/rooms/:id/ws`). */
  path?: string;
  /**
   * Platform binding that hosts this gateway's sockets, such as a Cloudflare
   * Durable Object namespace. A forwarding transport serves the upgrade route
   * and delivers each upgrade there; in-process hosts ignore it.
   */
  binding?: string;
  /**
   * Path parameter used as the room id. Required for every parameterized path
   * so routing remains explicit across transports.
   */
  roomParam?: string;
  /**
   * Browser origins allowed to open the socket. Omitted means same-origin;
   * non-browser clients without an Origin header are allowed. `'*'` is an
   * explicit opt-out. A function derives the list from the application's
   * `ENV` once per application, so the gateway declaration stays static.
   */
  allowedOrigins?: '*' | readonly string[] | ((env: VelaEnv) => readonly string[]);
  /** Optional additional authorization run before authentication/allocation. */
  authorizeUpgrade?: (request: Request) => boolean | Promise<boolean>;
  /**
   * The {@link UpgradeAuthenticator} class that turns an upgrade request into
   * a trusted identity. Every successful upgrade needs one; a gateway without
   * it fails closed.
   */
  authenticator?: Type<UpgradeAuthenticator>;
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
  handleReservedEvent(
    path: string,
    client: WsClient,
    message: WsMessage,
    context?: WsExecutionContext,
  ): void | Promise<void>;
  handleSocketClose?(path: string, client: WsClient): void | Promise<void>;
}

/**
 * An authenticated upgrade that a forwarding {@link WebSocketTransport}
 * delivers to the instance holding its room's sockets.
 */
export interface ForwardedWebSocketUpgrade {
  /**
   * The upgrade request: its `ticket` query parameter and every client copy of
   * the transport's `forwardingHeaders` are removed.
   */
  request: Request;
  /** The gateway's route path (`@WebSocketGateway({ path })`). */
  gatewayPath: string;
  /** The room this socket joins, resolved from the gateway's `roomParam`. */
  room: string;
  /** The gateway's `binding`: the platform namespace that owns the room. */
  binding: string;
  /**
   * The identity the gateway's authenticator verified. When a trusted request
   * identity also exists, both must agree, and the earlier expiry wins.
   */
  identity: WebSocketUpgradeIdentity;
}

/**
 * One gateway room a `Gateways` push goes to, built from the gateway's
 * `@WebSocketGateway` metadata.
 */
export interface GatewayDelivery {
  /** The gateway's route path (`@WebSocketGateway({ path })`). */
  gatewayPath: string;
  /** The gateway's `binding`, when it names one. */
  binding?: string;
  /**
   * The gateway room whose sockets receive the push: a `roomParam` value, or
   * the gateway's path when it declares no `roomParam` (its upgrades all join
   * that one room).
   */
  room: string;
  /**
   * The push, already bounded by the gateway's `maxFrameBytes`. Its `rooms`
   * are every room the push names and its `gatewayPath` is the gateway's;
   * deliver it to the gateway's sockets of `room` that belong to any of them.
   */
  command: BroadcastCommand;
}

/**
 * Platform wiring for `WebSocketModule`: a runtime adapter registers one as
 * the global `WS_TRANSPORT`. Without one, sockets live in this process and a
 * host serves them (`registerWebSocketGateways` on node, Bun and Deno).
 */
export interface WebSocketTransport {
  /**
   * Build the server gateways inject with `@WebSocketServer()`. `driver` is
   * the module's sync driver; a transport that owns socket delivery may ignore
   * it. Defaults to a server that broadcasts through `driver`, or, when the
   * transport `deliver`s pushes, to one that keeps no sockets and refuses each
   * push with guidance to `Gateways`.
   */
  createServer?(driver: SyncDriver): WsServer;
  /**
   * Deliver a `Gateways` push to the isolate that holds one gateway room's
   * sockets. `Gateways` calls it once per room; without it, pushes go through
   * the module's sync driver to the gateway's sockets in this process (and,
   * with `redis()`, on every instance).
   */
  deliver?(delivery: GatewayDelivery): Promise<void>;
  /**
   * Deliver an upgrade to the isolate that holds the room's sockets. When the
   * transport forwards, `WebSocketModule` mounts an upgrade route for each
   * gateway that names a `binding`: the route authenticates the upgrade before
   * any remote allocation, then calls this method.
   */
  forwardUpgrade?(upgrade: ForwardedWebSocketUpgrade): Promise<Response>;
  /**
   * Headers `forwardUpgrade` uses to carry trusted values. Client-supplied
   * copies are removed before any application hook sees the upgrade.
   */
  readonly forwardingHeaders?: readonly string[];
}

/**
 * The payload arguments of one pushed event: optional when its payload type
 * admits `undefined`, required otherwise.
 */
export type GatewayEventArgs<Events, Event extends keyof Events> = undefined extends Events[Event]
  ? [data?: Events[Event]]
  : [data: Events[Event]];

/**
 * Pushes to the gateway rooms it names, typed by the gateway's event map
 * (event name → payload type).
 */
export interface GatewayBroadcastOperator<Events extends object = Record<string, unknown>> {
  /** Also push to this room. */
  to(room: string): GatewayBroadcastOperator<Events>;
  /** Alias of {@link GatewayBroadcastOperator.to}. */
  in(room: string): GatewayBroadcastOperator<Events>;
  /**
   * Not supported: a push reaches every socket in every room it names.
   * Filter recipients in the gateway with `authorizeDelivery` instead.
   */
  except(room: string): never;
  /** Frame `{ event, data }` and deliver it to the named rooms' sockets. */
  emit<Event extends keyof Events & string>(
    event: Event,
    ...data: GatewayEventArgs<Events, Event>
  ): Promise<void>;
}

/**
 * The typed push handle of one gateway, from `Gateways.of(Gateway)`. A push
 * names its rooms first: `to(room).emit(event, data)`.
 */
export interface GatewayServer<Events extends object = Record<string, unknown>> {
  /** The gateway's route path. */
  readonly path: string;
  /** Push to this room of the gateway. */
  to(room: string): GatewayBroadcastOperator<Events>;
  /** Alias of {@link GatewayServer.to}. */
  in(room: string): GatewayBroadcastOperator<Events>;
  /**
   * Not supported: sockets live in their room's isolate, so a push without a
   * room would reach no one. Name the rooms with `to(room)`.
   */
  emit(...args: never[]): never;
  /**
   * Not supported: a push reaches every socket in every room it names.
   * Filter recipients in the gateway with `authorizeDelivery` instead.
   */
  except(room: string): never;
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
  /**
   * Deliver only to sockets that connected through this gateway path
   * (`WsClient.path`). `Gateways` sets it on every push, so rooms that share
   * an id across gateways stay separate on every runtime.
   */
  gatewayPath?: string;
  /** The exact bytes written to each socket: `JSON.stringify({ event, data })`. */
  frame: string;
  /** Origin instance/DO id — lets pub/sub drivers drop their own echo. */
  origin?: string;
}
