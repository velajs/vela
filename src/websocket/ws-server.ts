import type { SyncDriver } from './ws-sync';
import type { BroadcastCommand, BroadcastOperator, WsServer } from './websocket.types';

/**
 * Accumulates `{ rooms, exceptRooms, exceptIds }` across a fluent chain and, on
 * `.emit()`, produces a serializable `BroadcastCommand` handed to the active
 * `SyncDriver`. The driver decides local-vs-remote delivery.
 */
export class BroadcastOperatorImpl implements BroadcastOperator {
  constructor(
    private readonly driver: SyncDriver,
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
    return this.driver.dispatch(cmd);
  }
}

/**
 * The `@WebSocketServer()`-injected handle. Server-origin broadcasts never
 * pre-exclude anyone (a client-origin `client.to()` seeds `exceptIds` with the
 * sender — that lives in the transport's client, not here).
 */
export class WsServerImpl implements WsServer {
  constructor(private readonly driver: SyncDriver) {}

  emit(event: string, data?: unknown): void | Promise<void> {
    // Empty `rooms` means GLOBAL.
    return this.driver.dispatch({ rooms: [], frame: JSON.stringify({ event, data }) });
  }

  to(room: string): BroadcastOperator {
    return new BroadcastOperatorImpl(this.driver).to(room);
  }

  in(room: string): BroadcastOperator {
    return this.to(room);
  }

  except(room: string): BroadcastOperator {
    return new BroadcastOperatorImpl(this.driver).except(room);
  }
}
