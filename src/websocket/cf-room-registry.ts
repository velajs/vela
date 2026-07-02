import type { BroadcastCommand, RoomRegistry, WsClient } from '@velajs/vela/websocket';
import type { DoStateLike, WsAttachment, WsLike } from './do-state';
import { CfWsClient } from './cf-ws-client';

/**
 * Core `RoomRegistry` backed by a Durable Object's hibernatable sockets. Room
 * membership lives in tags (hub room, set at accept) + the attachment (dynamic
 * `join()`), never in DO instance fields — so it survives hibernation with zero
 * rehydration.
 */
export class CfRoomRegistry implements RoomRegistry {
  constructor(private readonly ctx: DoStateLike) {}

  // CF sockets are registered with the DO by `acceptWebSocket`; nothing to track.
  register(_client: WsClient): void {}
  leaveAll(_client: WsClient): void {}

  join(client: WsClient, room: string): void | Promise<void> {
    return client.join(room);
  }

  leave(client: WsClient, room: string): void | Promise<void> {
    return client.leave(room);
  }

  localIdsInRoom(room: string): string[] {
    return this.socketsForRoom(room).map((ws) => this.attachmentOf(ws).connId);
  }

  deliverLocal(cmd: BroadcastCommand): void {
    const excludeIds = new Set(cmd.exceptIds ?? []);
    const excludeRooms = cmd.exceptRooms ?? [];

    // Empty `rooms` => GLOBAL (every socket in this DO). Otherwise the union of
    // targeted rooms, deduped per connection.
    const targets =
      cmd.rooms.length === 0 ? this.ctx.getWebSockets() : this.collectRooms(cmd.rooms);

    const seen = new Set<string>();
    for (const ws of targets) {
      const att = this.attachmentOf(ws);
      if (seen.has(att.connId)) continue;
      seen.add(att.connId);
      if (excludeIds.has(att.connId)) continue;
      if (excludeRooms.some((r) => att.rooms.includes(r))) continue;
      ws.send(cmd.frame);
    }
  }

  private collectRooms(rooms: string[]): WsLike[] {
    const set = new Set<WsLike>();
    for (const room of rooms) for (const ws of this.socketsForRoom(room)) set.add(ws);
    return [...set];
  }

  private socketsForRoom(room: string): WsLike[] {
    // Membership is the attachment's `rooms`, NOT the hibernation tag: tags are
    // immutable after acceptWebSocket, so a socket that left its hub room still
    // carries the tag. Since one DO ≈ one room, scanning all sockets in the DO
    // and filtering by attachment is both correct and cheap.
    return this.ctx.getWebSockets().filter((ws) => this.attachmentOf(ws).rooms.includes(room));
  }

  private attachmentOf(ws: WsLike): WsAttachment {
    return (ws.deserializeAttachment() as WsAttachment | null) ?? { connId: '', path: '', rooms: [], data: {} };
  }

  /** Reconstruct a `WsClient` for a raw socket (e.g. inside gateway lifecycle scans). */
  clientFor(ws: WsLike): WsClient {
    return new CfWsClient(this.ctx, ws);
  }
}
