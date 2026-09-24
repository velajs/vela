import { InjectionToken, type Constructor } from '../container/types';
import type { SyncDriver } from './ws-sync';
import { assertBroadcastCommandFits } from './ws-sync';
import { DEFAULT_WS_MAX_FRAME_BYTES, resolveMaxFrameBytes } from './gateway-routing';
import type {
  BroadcastCommand,
  BroadcastOperator,
  WebSocketGatewayOptions,
  WebSocketTransport,
  WsServer,
} from './websocket.types';

/**
 * Accumulates `{ rooms, exceptRooms, exceptIds }` across a fluent chain and, on
 * `.emit()`, produces a serializable `BroadcastCommand` handed to the active
 * `SyncDriver`. The driver decides local-vs-remote delivery. A gateway's
 * server passes its `gatewayPath`, which every command then carries.
 */
export class BroadcastOperatorImpl implements BroadcastOperator {
  constructor(
    private readonly driver: SyncDriver,
    private readonly maxFrameBytes: () => number = () => DEFAULT_WS_MAX_FRAME_BYTES,
    private readonly rooms = new Set<string>(),
    private readonly exceptRooms = new Set<string>(),
    private readonly exceptIds = new Set<string>(),
    private readonly gatewayPath?: string,
  ) {}

  to(room: string): this {
    this.rooms.add(room);
    return this;
  }

  in(room: string): this {
    return this.to(room);
  }

  except(room: string): this {
    this.exceptRooms.add(room);
    return this;
  }

  emit(event: string, data?: unknown): void | Promise<void> {
    const cmd: BroadcastCommand = {
      rooms: [...this.rooms],
      exceptRooms: this.exceptRooms.size ? [...this.exceptRooms] : undefined,
      exceptIds: this.exceptIds.size ? [...this.exceptIds] : undefined,
      ...(this.gatewayPath === undefined ? {} : { gatewayPath: this.gatewayPath }),
      frame: JSON.stringify({ event, data }),
    };
    assertBroadcastCommandFits(cmd, this.maxFrameBytes());
    return this.driver.dispatch(cmd);
  }
}

/**
 * The in-process server. Server-origin broadcasts never pre-exclude anyone (a
 * client-origin `client.to()` seeds `exceptIds` with the sender — that lives
 * in the transport's client, not here). Injected outside a gateway it
 * addresses every gateway's sockets; each gateway's `@WebSocketServer()` is
 * its {@link WsServerImpl.forGateway} view.
 */
export class WsServerImpl implements WsServer {
  private maxFrameBytes = DEFAULT_WS_MAX_FRAME_BYTES;
  private hasGatewayLimit = false;

  /**
   * `gatewayPath` builds one gateway's view: each push carries it, and the
   * module's driver keeps the ceiling the module server gave it.
   */
  constructor(
    private readonly driver: SyncDriver,
    private readonly gatewayPath?: string,
  ) {
    if (gatewayPath === undefined) this.driver.setMaxFrameBytes?.(this.maxFrameBytes);
  }

  setOutboundFrameLimit(maxFrameBytes: number): void {
    if (this.gatewayPath !== undefined) return; // a gateway's view keeps its own ceiling
    const resolved = resolveMaxFrameBytes({ maxFrameBytes });
    this.maxFrameBytes = this.hasGatewayLimit ? Math.max(this.maxFrameBytes, resolved) : resolved;
    this.hasGatewayLimit = true;
    this.driver.setMaxFrameBytes?.(this.maxFrameBytes);
  }

  forGateway(gatewayPath: string, maxFrameBytes: number): WsServer {
    const server = new WsServerImpl(this.driver, gatewayPath);
    server.maxFrameBytes = maxFrameBytes;
    return server;
  }

  emit(event: string, data?: unknown): void | Promise<void> {
    // Empty `rooms` means GLOBAL.
    const command: BroadcastCommand = {
      rooms: [],
      ...(this.gatewayPath === undefined ? {} : { gatewayPath: this.gatewayPath }),
      frame: JSON.stringify({ event, data }),
    };
    assertBroadcastCommandFits(command, this.maxFrameBytes);
    return this.driver.dispatch(command);
  }

  to(room: string): BroadcastOperator {
    return this.operator().to(room);
  }

  in(room: string): BroadcastOperator {
    return this.to(room);
  }

  except(room: string): BroadcastOperator {
    return this.operator().except(room);
  }

  private operator(): BroadcastOperatorImpl {
    return new BroadcastOperatorImpl(
      this.driver,
      () => this.maxFrameBytes,
      undefined,
      undefined,
      undefined,
      this.gatewayPath,
    );
  }
}

/**
 * What a gateway's `@WebSocketServer()` injects. `WsDispatcher` connects it to
 * the gateway's own server ({@link WsServer.forGateway}) when it discovers the
 * gateway, so the gateway's pushes reach only the sockets connected through it.
 */
export class GatewayServerHandle implements WsServer {
  #server?: WsServer;
  #resolve?: () => WsServer | undefined;

  constructor(private readonly gatewayName: string) {}

  /**
   * Connect the gateway's server, looked up on first use; the first
   * connection wins.
   */
  connect(resolve: () => WsServer | undefined): void {
    this.#resolve ??= resolve;
  }

  emit(event: string, data?: unknown): void | Promise<void> {
    return this.#target().emit(event, data);
  }

  to(room: string): BroadcastOperator {
    return this.#target().to(room);
  }

  in(room: string): BroadcastOperator {
    return this.#target().in(room);
  }

  except(room: string): BroadcastOperator {
    return this.#target().except(room);
  }

  #target(): WsServer {
    this.#server ??= this.#resolve?.();
    if (this.#server) return this.#server;
    throw new Error(
      `${this.gatewayName}'s @WebSocketServer() is not connected: WebSocketModule connects ` +
        'the server of each gateway it discovers while the application starts, so import ' +
        "WebSocketModule.forRoot() in the gateway's application. A WS_SERVER without " +
        'WebSocketModule connects nothing: to push to a test double, keep that import and ' +
        "provide WS_SERVER in the gateway's module or override WS_SERVER in the testing module.",
    );
  }
}

const gatewayServerTokens = new WeakMap<Constructor, InjectionToken<GatewayServerHandle>>();
const gatewayServerTokenSet = new WeakSet<object>();

/** The token of the server one gateway class injects (a {@link GatewayServerHandle}). */
export function gatewayServerToken(gateway: Constructor): InjectionToken<GatewayServerHandle> {
  let token = gatewayServerTokens.get(gateway);
  if (!token) {
    const name = gateway.name;
    token = new InjectionToken(`WS_SERVER(${name})`, {
      factory: () => new GatewayServerHandle(name),
    });
    gatewayServerTokens.set(gateway, token);
    gatewayServerTokenSet.add(token);
  }
  return token;
}

/** Whether `token` is the server token of some gateway class. */
export function isGatewayServerToken(token: unknown): boolean {
  return typeof token === 'object' && token !== null && gatewayServerTokenSet.has(token);
}

const REMOTE_SOCKETS =
  "This isolate holds none of the gateways' sockets: the platform keeps each room's " +
  'sockets elsewhere. Push with Gateways from @velajs/vela/websocket: ' +
  'gateways.of(Gateway).to(room).emit(event, data).';

/**
 * The server gateways inject where a platform transport keeps every socket in
 * another isolate: each push fails with guidance to `Gateways`, which
 * addresses a gateway room, instead of reaching no one.
 */
export class RemoteSocketsWsServer implements WsServer {
  constructor(private readonly guidance = REMOTE_SOCKETS) {}

  emit(): never {
    throw new Error(this.guidance);
  }
  to(): never {
    throw new Error(this.guidance);
  }
  in(): never {
    throw new Error(this.guidance);
  }
  except(): never {
    throw new Error(this.guidance);
  }
}

/**
 * Whether a push through this process cannot reach the sockets of a gateway
 * whose upgrades `transport` forwards (one that names a `binding`): the
 * transport delivers no pushes, and the `local()` sync driver keeps each push
 * in this process. A cross-instance driver, such as `redis()`, may reach the
 * isolate that holds them.
 */
export function forwardedSocketsUnreachable(
  transport: WebSocketTransport | undefined,
  driver: SyncDriver,
): boolean {
  return (
    transport?.forwardUpgrade !== undefined &&
    transport.deliver === undefined &&
    driver.kind === 'local'
  );
}

function forwardedSockets(gatewayName: string): string {
  return (
    `${gatewayName}'s upgrades are forwarded by the platform transport, so its sockets live in ` +
    'another isolate, but neither the transport nor the local() sync driver delivers pushes there.'
  );
}

/** Why a `Gateways` push to a gateway whose sockets are unreachable rejects. */
export function forwardedGatewayPushError(gatewayName: string): Error {
  return new Error(
    `${forwardedSockets(gatewayName)} A transport that implements forwardUpgrade() must also ` +
      'implement WebSocketTransport.deliver() for Gateways pushes, unless the sync driver ' +
      'reaches that isolate.',
  );
}

/**
 * `WS_SERVER` where the platform transport forwards upgrades to another
 * isolate but neither builds the server nor delivers pushes, and the
 * `local()` sync driver keeps each push in this process. It broadcasts like
 * {@link WsServerImpl}; {@link gatewayServerOf} gives a gateway whose
 * upgrades are forwarded a server that refuses each push instead.
 */
export class ForwardedUpgradesWsServer extends WsServerImpl {}

/**
 * The server one gateway's `@WebSocketServer()` pushes through, built from
 * the `WS_SERVER` its module sees: that server's view of the gateway
 * ({@link WsServer.forGateway}), else the server itself. A forwarded gateway
 * of a {@link ForwardedUpgradesWsServer} gets a server that refuses each push
 * with guidance, as a `Gateways` push to it rejects.
 */
export function gatewayServerOf(
  server: WsServer,
  gatewayName: string,
  options: WebSocketGatewayOptions,
): WsServer {
  if (options.binding !== undefined && server instanceof ForwardedUpgradesWsServer) {
    return new RemoteSocketsWsServer(
      `${gatewayName}'s @WebSocketServer() cannot reach its sockets: ` +
        `${forwardedSockets(gatewayName)} Implement WebSocketTransport.deliver() in the ` +
        'transport and push with Gateways, or createServer() to build a server that reaches them.',
    );
  }
  return (
    server.forGateway?.(options.path ?? '', options.maxFrameBytes ?? DEFAULT_WS_MAX_FRAME_BYTES) ??
    server
  );
}
