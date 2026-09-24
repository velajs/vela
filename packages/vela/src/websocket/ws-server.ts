import type { SyncDriver } from './ws-sync';
import { assertBroadcastCommandFits } from './ws-sync';
import { DEFAULT_WS_MAX_FRAME_BYTES, resolveMaxFrameBytes } from './gateway-routing';
import type { BroadcastCommand, BroadcastOperator, WsServer } from './websocket.types';

/**
 * Accumulates `{ rooms, exceptRooms, exceptIds }` across a fluent chain and, on
 * `.emit()`, produces a serializable `BroadcastCommand` handed to the active
 * `SyncDriver`. The driver decides local-vs-remote delivery.
 */
export class BroadcastOperatorImpl implements BroadcastOperator {
  constructor(
    private readonly driver: SyncDriver,
    private readonly maxFrameBytes: () => number = () => DEFAULT_WS_MAX_FRAME_BYTES,
    private readonly rooms = new Set<string>(),
    private readonly exceptRooms = new Set<string>(),
    private readonly exceptIds = new Set<string>(),
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
      frame: JSON.stringify({ event, data }),
    };
    assertBroadcastCommandFits(cmd, this.maxFrameBytes());
    return this.driver.dispatch(cmd);
  }
}

/**
 * The `@WebSocketServer()`-injected handle. Server-origin broadcasts never
 * pre-exclude anyone (a client-origin `client.to()` seeds `exceptIds` with the
 * sender — that lives in the transport's client, not here).
 */
export class WsServerImpl implements WsServer {
  private maxFrameBytes = DEFAULT_WS_MAX_FRAME_BYTES;
  private hasGatewayLimit = false;

  constructor(private readonly driver: SyncDriver) {
    this.driver.setMaxFrameBytes?.(this.maxFrameBytes);
  }

  setOutboundFrameLimit(maxFrameBytes: number): void {
    const resolved = resolveMaxFrameBytes({ maxFrameBytes });
    this.maxFrameBytes = this.hasGatewayLimit ? Math.max(this.maxFrameBytes, resolved) : resolved;
    this.hasGatewayLimit = true;
    this.driver.setMaxFrameBytes?.(this.maxFrameBytes);
  }

  emit(event: string, data?: unknown): void | Promise<void> {
    // Empty `rooms` means GLOBAL.
    const command: BroadcastCommand = { rooms: [], frame: JSON.stringify({ event, data }) };
    assertBroadcastCommandFits(command, this.maxFrameBytes);
    return this.driver.dispatch(command);
  }

  to(room: string): BroadcastOperator {
    return new BroadcastOperatorImpl(this.driver, () => this.maxFrameBytes).to(room);
  }

  in(room: string): BroadcastOperator {
    return this.to(room);
  }

  except(room: string): BroadcastOperator {
    return new BroadcastOperatorImpl(this.driver, () => this.maxFrameBytes).except(room);
  }
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
  emit(): never {
    throw new Error(REMOTE_SOCKETS);
  }
  to(): never {
    throw new Error(REMOTE_SOCKETS);
  }
  in(): never {
    throw new Error(REMOTE_SOCKETS);
  }
  except(): never {
    throw new Error(REMOTE_SOCKETS);
  }
}
