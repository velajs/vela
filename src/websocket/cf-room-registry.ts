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
  private deliveryAuthorizer?: (client: WsClient) => boolean | Promise<boolean>;
  private frameLimitForPath?: (path: string) => number | undefined;

  constructor(private readonly ctx: DoStateLike) {}

  setDeliveryAuthorizer(authorizer: (client: WsClient) => boolean | Promise<boolean>): void {
    this.deliveryAuthorizer = authorizer;
  }

  /** Reconcile pre-migration/woken attachments with authoritative gateway metadata. */
  setFrameLimitResolver(resolver: (path: string) => number | undefined): void {
    this.frameLimitForPath = resolver;
  }

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

  deliverLocal(cmd: BroadcastCommand): void | Promise<void> {
    const excludeIds = new Set(cmd.exceptIds ?? []);
    const excludeRooms = cmd.exceptRooms ?? [];

    // Empty `rooms` => GLOBAL (every socket in this DO). Otherwise the union of
    // targeted rooms, deduped per connection.
    const targets =
      cmd.rooms.length === 0 ? this.ctx.getWebSockets() : this.collectRooms(cmd.rooms);

    const seen = new Set<string>();
    const selected: Array<{ ws: WsLike; client: WsClient }> = [];
    for (const ws of targets) {
      const att = this.reconcileFrameLimit(ws, this.attachmentOf(ws));
      if (seen.has(att.connId)) continue;
      seen.add(att.connId);
      if (
        att.state !== 'active' ||
        (att.expiresAtMs !== undefined &&
          (!Number.isSafeInteger(att.expiresAtMs) || att.expiresAtMs <= Date.now()))
      ) {
        try {
          att.state = 'rejected';
          ws.serializeAttachment(att);
          ws.close(1008, 'identity expired or connection rejected');
        } catch {
          // already closed or malformed attachment
        }
        continue;
      }
      if (excludeIds.has(att.connId)) continue;
      if (excludeRooms.some((r) => att.rooms.includes(r))) continue;
      selected.push({ ws, client: new CfWsClient(this.ctx, ws) });
    }

    if (!this.deliveryAuthorizer) {
      for (const { client } of selected) client.sendRaw(cmd.frame);
      return;
    }
    return Promise.all(
      selected.map(async ({ ws, client }) => {
        let allowed = false;
        try {
          allowed = (await this.deliveryAuthorizer!(client)) === true;
        } catch {
          allowed = false;
        }
        if (allowed) client.sendRaw(cmd.frame);
        else this.reject(ws, 'delivery authorization revoked');
      }),
    ).then(() => undefined);
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
    return (
      (ws.deserializeAttachment() as WsAttachment | null) ?? {
        connId: '',
        state: 'rejected',
        path: '',
        rooms: [],
        data: {},
      }
    );
  }

  /** Reconstruct a `WsClient` for a raw socket (e.g. inside gateway lifecycle scans). */
  clientFor(ws: WsLike): CfWsClient {
    this.reconcileFrameLimit(ws, this.attachmentOf(ws));
    return new CfWsClient(this.ctx, ws);
  }

  private reconcileFrameLimit(ws: WsLike, attachment: WsAttachment): WsAttachment {
    const expected = this.frameLimitForPath?.(attachment.path);
    if (expected !== undefined && attachment.maxFrameBytes !== expected) {
      attachment.maxFrameBytes = expected;
      ws.serializeAttachment(attachment);
    }
    return attachment;
  }

  private reject(ws: WsLike, reason: string): void {
    try {
      const attachment = this.attachmentOf(ws);
      attachment.state = 'rejected';
      ws.serializeAttachment(attachment);
      ws.close(1008, reason);
    } catch {
      // already closed or malformed attachment
    }
  }
}
