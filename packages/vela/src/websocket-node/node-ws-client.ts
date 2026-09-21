import {
  WebSocketSendGate,
  type WebSocketSendPolicy,
  type WebSocketSendResult,
} from '@velajs/live-protocol';
import type { WSContext } from 'hono/ws';
import type { RoomRegistry, WsClient } from '../websocket/index';
import {
  assertWebSocketRoomId,
  DEFAULT_WS_MAX_FRAME_BYTES,
  DEFAULT_WS_MAX_JOINED_ROOMS,
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
  readonly #sendGate: WebSocketSendGate;
  readonly #rooms = new Set<string>();

  constructor(
    private readonly ws: WSContext,
    private readonly registry: RoomRegistry,
    readonly path: string,
    readonly maxFrameBytes: number = DEFAULT_WS_MAX_FRAME_BYTES,
    sendPolicy?: WebSocketSendPolicy,
  ) {
    this.#sendGate = new WebSocketSendGate(sendPolicy);
  }

  get rooms(): ReadonlySet<string> {
    return this.#rooms;
  }

  get raw(): unknown {
    return this.ws;
  }

  send(event: string, data?: unknown, id?: string): void {
    this.sendRaw(JSON.stringify(id !== undefined ? { id, event, data } : { event, data }));
  }

  sendRaw(payload: string): void {
    this.trySendRaw(payload);
  }

  trySendRaw(payload: string): WebSocketSendResult {
    const raw = this.ws.raw;
    const bufferedAmount =
      raw &&
      typeof raw === 'object' &&
      'bufferedAmount' in raw &&
      typeof raw.bufferedAmount === 'number'
        ? raw.bufferedAmount
        : undefined;
    return this.#sendGate.trySend(
      {
        readyState: this.ws.readyState,
        bufferedAmount,
        send: (frame) => this.ws.send(frame),
        close: (code, reason) => this.close(code, reason),
      },
      payload,
      this.maxFrameBytes,
    );
  }

  join(room: string): void | Promise<void> {
    assertWebSocketRoomId(room);
    if (!this.#rooms.has(room) && this.#rooms.size >= DEFAULT_WS_MAX_JOINED_ROOMS) {
      throw new Error(`A WebSocket may join at most ${DEFAULT_WS_MAX_JOINED_ROOMS} rooms`);
    }
    this.#rooms.add(room);
    return this.registry.join(this, room);
  }

  leave(room: string): void | Promise<void> {
    this.#rooms.delete(room);
    return this.registry.leave(this, room);
  }

  // In-memory registry mutates eagerly; nothing deferred to persist.
  commit(): void {}

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}
