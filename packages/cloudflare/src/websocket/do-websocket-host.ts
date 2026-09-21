import { socketAttachment } from './ws-attachment';
import { WsMessageQueue, assertBroadcastCommandFits } from '@velajs/vela/websocket';
import type { BroadcastCommand, WsDispatcher } from '@velajs/vela/websocket';
import type { CfRoomRegistry } from './cf-room-registry';
import {
  MAX_WS_ATTACHMENT_BYTES,
  type DoStateLike,
  type WsAttachment,
  type WsLike,
} from './do-state';
import { connTag, roomTag } from './room-id';

export interface WsConnectionPrincipal {
  issuer: string;
  subject: string;
  principalType: 'user' | 'service';
  tenantId: string;
}

/**
 * The socket lifecycle inside a WebSocket Durable Object, decoupled from the
 * `cloudflare:workers` base class so it is unit-testable with fakes. The thin
 * `VelaWebSocketDurableObject` shell forwards its hibernation callbacks here.
 */
export class DoWebSocketHost {
  readonly #messages = new WeakMap<WsLike, WsMessageQueue>();
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
   * persist the attachment, then await `OnGatewayConnection` before the caller
   * returns 101. A rejected lifecycle hook closes and fails the upgrade.
   */
  async accept(
    ws: WsLike,
    path: string,
    roomId: string,
    userId?: string,
    expiresAtMs?: number,
    principal?: WsConnectionPrincipal,
  ): Promise<boolean> {
    const maxFrameBytes = this.dispatcher.getGatewayMaxFrameBytes(path);
    if (maxFrameBytes === undefined) return false;
    if (
      expiresAtMs !== undefined &&
      (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now())
    ) {
      return false;
    }
    if (
      (principal !== undefined &&
        (expiresAtMs === undefined ||
          userId !== principal.subject ||
          !principal.issuer ||
          !principal.tenantId)) ||
      (expiresAtMs !== undefined && principal === undefined)
    ) {
      return false;
    }

    const connId = crypto.randomUUID();
    const attachment: WsAttachment = {
      version: 1,
      connId,
      state: 'pending',
      userId,
      principal:
        principal === undefined
          ? undefined
          : {
              issuer: principal.issuer,
              subject: principal.subject,
              principalType: principal.principalType,
            },
      tenantId: principal?.tenantId,
      expiresAtMs,
      path,
      maxFrameBytes,
      rooms: [roomId],
      data: {
        ...(userId ? { userId } : {}),
        ...(principal
          ? {
              principal: {
                issuer: principal.issuer,
                subject: principal.subject,
                principalType: principal.principalType,
              },
              tenantId: principal.tenantId,
            }
          : {}),
        ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
      },
    };
    if (new TextEncoder().encode(JSON.stringify(attachment)).byteLength > MAX_WS_ATTACHMENT_BYTES) {
      return false;
    }
    try {
      this.ctx.acceptWebSocket(ws, [roomTag(roomId), connTag(connId)]);
      ws.serializeAttachment(attachment);
    } catch {
      try {
        ws.close(1008, 'Connection rejected');
      } catch {
        // already closed
      }
      return false;
    }

    const client = this.registry.clientFor(ws);
    try {
      await this.dispatcher.handleOpen(path, client);
      // Another callback may have rejected the socket while the asynchronous
      // connection hook was still pending. Never resurrect that terminal state
      // after the hook resolves.
      if (!this.transition(ws, 'active', 'pending')) {
        throw new Error('Unable to persist authorized WebSocket state');
      }
      return true;
    } catch (err) {
      await this.dispatcher.handleError(path, client, err).catch(() => {});
      this.transition(ws, 'rejected');
      try {
        ws.close(1008, 'Connection rejected');
      } catch {
        // already closed
      }
      return false;
    }
  }

  async onMessage(ws: WsLike, message: string | ArrayBuffer): Promise<void> {
    if (!this.isActive(ws)) {
      this.reject(ws, 'Connection is not authorized');
      return;
    }
    let queue = this.#messages.get(ws);
    if (!queue) {
      const path = socketAttachment(ws)?.path;
      const options = this.dispatcher.collectEntrypoints().find((entry) => entry.meta.path === path)
        ?.meta.options;
      queue = new WsMessageQueue(
        () => this.reject(ws, 'WebSocket message budget exceeded', 1013),
        options?.maxPendingMessages,
        options?.maxPendingBytes,
      );
      this.#messages.set(ws, queue);
    }
    await queue.run(message, async () => {
      if (!this.isActive(ws)) return;
      const client = this.registry.clientFor(ws);
      await this.dispatcher.dispatchMessage(client.path, client, message);
    });
  }

  async onClose(ws: WsLike, code: number, reason: string): Promise<void> {
    this.#messages.get(ws)?.stop();
    if (!this.isActive(ws, false)) {
      this.transition(ws, 'rejected');
      try {
        ws.close();
      } catch {
        // already closed
      }
      return;
    }
    const client = this.registry.clientFor(ws);
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
    if (!this.isActive(ws, false)) {
      this.reject(ws, 'Connection failed before authorization');
      return;
    }
    const client = this.registry.clientFor(ws);
    await this.dispatcher.handleError(client.path, client, err);
  }

  /** Deliver a broadcast command to this DO's local sockets (RPC entry point). */
  broadcast(cmd: BroadcastCommand): void | Promise<void> {
    assertBroadcastCommandFits(cmd, this.dispatcher.getMaximumGatewayFrameBytes());
    return this.registry.deliverLocal(cmd);
  }

  private transition(
    ws: WsLike,
    state: WsAttachment['state'],
    expectedState?: WsAttachment['state'],
  ): boolean {
    try {
      const attachment = socketAttachment(ws);
      if (!attachment) return false;
      if (expectedState !== undefined && attachment.state !== expectedState) return false;
      attachment.state = state;
      ws.serializeAttachment(attachment);
      return true;
    } catch {
      return false;
    }
  }

  private isActive(ws: WsLike, checkExpiry = true): boolean {
    try {
      const attachment = socketAttachment(ws);
      if (!attachment || attachment.state !== 'active') return false;
      return (
        !checkExpiry ||
        attachment.expiresAtMs === undefined ||
        (Number.isSafeInteger(attachment.expiresAtMs) && attachment.expiresAtMs > Date.now())
      );
    } catch {
      return false;
    }
  }

  private reject(ws: WsLike, reason: string, code = 1008): void {
    this.#messages.get(ws)?.stop();
    this.transition(ws, 'rejected');
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}
