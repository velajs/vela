import type { WSContext } from 'hono/ws';
import type { RoomRegistry, WsClient } from '../websocket/index';
import {
  assertWebSocketRoomId,
  DEFAULT_WS_MAX_FRAME_BYTES,
  DEFAULT_WS_MAX_JOINED_ROOMS,
  webSocketFrameFits,
} from '../websocket/gateway-routing';

/**
 * Core `WsClient` over Hono's `WSContext` (node/bun/deno — no hibernation).
 * Room membership is mirrored into the shared `RoomRegistry` so broadcasts from
 * the `WsServer` reach this connection.
 */
export class NodeWsClient<
  TData extends Record<string, unknown> = Record<string, unknown>,
> implements WsClient<TData> {
  readonly id: string = crypto.randomUUID();
  data: TData = {} as TData;
  private readonly _rooms = new Set<string>();

  constructor(
    private readonly ws: WSContext,
    private readonly registry: RoomRegistry,
    readonly path: string,
    readonly maxFrameBytes: number = DEFAULT_WS_MAX_FRAME_BYTES,
  ) {}

  get rooms(): ReadonlySet<string> {
    return this._rooms;
  }

  get raw(): unknown {
    return this.ws;
  }

  send(event: string, data?: unknown, id?: string): void {
    this.sendRaw(JSON.stringify(id !== undefined ? { id, event, data } : { event, data }));
  }

  sendRaw(payload: string): void {
    if (!webSocketFrameFits(payload, this.maxFrameBytes)) {
      this.close(1009, 'Message too large');
      return;
    }
    this.ws.send(payload);
  }

  join(room: string): void | Promise<void> {
    assertWebSocketRoomId(room);
    if (!this._rooms.has(room) && this._rooms.size >= DEFAULT_WS_MAX_JOINED_ROOMS) {
      throw new Error(`A WebSocket may join at most ${DEFAULT_WS_MAX_JOINED_ROOMS} rooms`);
    }
    this._rooms.add(room);
    return this.registry.join(this, room);
  }

  leave(room: string): void | Promise<void> {
    this._rooms.delete(room);
    return this.registry.leave(this, room);
  }

  // In-memory registry mutates eagerly; nothing deferred to persist.
  commit(): void {}

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}
