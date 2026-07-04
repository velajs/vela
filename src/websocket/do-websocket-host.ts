import type { BroadcastCommand, WsDispatcher } from '@velajs/vela/websocket';
import { CfWsClient } from './cf-ws-client';
import type { CfRoomRegistry } from './cf-room-registry';
import type { DoStateLike, WsAttachment, WsLike } from './do-state';
import { connTag, roomTag } from './room-id';

/**
 * The socket lifecycle inside a WebSocket Durable Object, decoupled from the
 * `cloudflare:workers` base class so it is unit-testable with fakes. The thin
 * `VelaWebSocketDurableObject` shell forwards its hibernation callbacks here.
 */
export class DoWebSocketHost {
  constructor(
    private readonly ctx: DoStateLike,
    private readonly dispatcher: WsDispatcher,
    private readonly registry: CfRoomRegistry,
    private readonly gatewayPaths: readonly string[] = [],
  ) {}

  /** The single registered gateway's path — a fallback when the Worker didn't forward `x-vela-path`. */
  defaultPath(): string | undefined {
    return this.gatewayPaths[0];
  }

  /**
   * Accept a hibernatable socket: tag it with its hub room + connection id,
   * persist the attachment, then fire `OnGatewayConnection` WITHOUT blocking the
   * 101 response (the caller returns it immediately).
   */
  accept(ws: WsLike, path: string, roomId: string, userId?: string): void {
    const connId = crypto.randomUUID();
    this.ctx.acceptWebSocket(ws, [roomTag(roomId), connTag(connId)]);

    const attachment: WsAttachment = {
      connId,
      userId,
      path,
      rooms: [roomId],
      data: userId ? { userId } : {},
    };
    ws.serializeAttachment(attachment);

    void Promise.resolve(this.dispatcher.handleOpen(path, new CfWsClient(this.ctx, ws))).catch(
      (err) => console.warn('[vela] websocket handleConnection failed:', err),
    );
  }

  async onMessage(ws: WsLike, message: string | ArrayBuffer): Promise<void> {
    const client = new CfWsClient(this.ctx, ws);
    await this.dispatcher.dispatchMessage(client.path, client, message);
  }

  async onClose(ws: WsLike, code: number, reason: string): Promise<void> {
    const client = new CfWsClient(this.ctx, ws);
    await this.dispatcher.handleClose(client.path, client, code, reason);
    // Complete the closing handshake. Only 1000 and 3000-4999 are valid for
    // close(); reserved/abnormal codes (1005/1006/1015, etc.) throw a RangeError,
    // so fall back to a codeless close on those.
    try {
      if (code === 1000 || (code >= 3000 && code <= 4999)) ws.close(code, reason);
      else ws.close();
    } catch {
      // socket already closed
    }
  }

  async onError(ws: WsLike, err: unknown): Promise<void> {
    const client = new CfWsClient(this.ctx, ws);
    await this.dispatcher.handleError(client.path, client, err);
  }

  /** Deliver a broadcast command to this DO's local sockets (RPC entry point). */
  broadcast(cmd: BroadcastCommand): void {
    this.registry.deliverLocal(cmd);
  }
}
