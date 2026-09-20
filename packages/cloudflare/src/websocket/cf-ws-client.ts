import type { WsClient } from '@velajs/vela/websocket';
import {
  assertWebSocketRoomId,
  DEFAULT_WS_MAX_FRAME_BYTES,
  DEFAULT_WS_MAX_JOINED_ROOMS,
  webSocketFrameFits,
} from '@velajs/vela/websocket';
import {
  MAX_WS_ATTACHMENT_BYTES,
  type DoStateLike,
  type WsAttachment,
  type WsLike,
} from './do-state';
const encoder = new TextEncoder();

const EMPTY: WsAttachment = { connId: '', state: 'rejected', path: '', rooms: [], data: {} };

/**
 * Core `WsClient` over a native Cloudflare `WebSocket` inside a Durable Object.
 * Per-connection state lives in the hibernation attachment (survives eviction),
 * so a fresh `CfWsClient` is reconstructed per message with no in-memory state.
 */
export class CfWsClient<
  TData extends Record<string, unknown> = Record<string, unknown>,
> implements WsClient<TData> {
  private readonly attachment: WsAttachment;

  constructor(
    private readonly ctx: DoStateLike,
    private readonly ws: WsLike,
  ) {
    const raw = ws.deserializeAttachment() as WsAttachment | null;
    this.attachment = raw ?? { ...EMPTY, data: {} };
  }

  get id(): string {
    return this.attachment.connId;
  }

  /** The gateway route path this socket connected on (used to route messages). */
  get path(): string {
    return this.attachment.path;
  }

  get rooms(): ReadonlySet<string> {
    return new Set(this.attachment.rooms);
  }

  get data(): TData {
    return this.attachment.data as TData;
  }

  set data(value: TData) {
    this.attachment.data = value;
  }

  get raw(): unknown {
    return this.ws;
  }

  get maxFrameBytes(): number {
    const value = this.attachment.maxFrameBytes;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : DEFAULT_WS_MAX_FRAME_BYTES;
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

  join(room: string): void {
    assertWebSocketRoomId(room);
    if (!this.attachment.rooms.includes(room)) {
      if (this.attachment.rooms.length >= DEFAULT_WS_MAX_JOINED_ROOMS) {
        throw new Error(`A WebSocket may join at most ${DEFAULT_WS_MAX_JOINED_ROOMS} rooms`);
      }
      this.attachment.rooms.push(room);
      this.persist();
    }
  }

  leave(room: string): void {
    const next = this.attachment.rooms.filter((r) => r !== room);
    if (next.length !== this.attachment.rooms.length) {
      this.attachment.rooms = next;
      this.persist();
    }
  }

  /** Persist `data`/room mutations to the hibernation attachment. */
  commit(): void {
    this.persist();
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  private persist(): void {
    const serialized = JSON.stringify(this.attachment);
    if (encoder.encode(serialized).length > MAX_WS_ATTACHMENT_BYTES) {
      throw new Error(
        `WebSocket attachment exceeds the 16 KiB Cloudflare limit. Store large ` +
          `per-connection state in Durable Object storage keyed by connId instead.`,
      );
    }
    this.ws.serializeAttachment(this.attachment);
  }
}
