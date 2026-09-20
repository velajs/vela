import { Injectable } from '@velajs/vela';
import { resolveMaxFrameBytes } from '@velajs/vela/websocket';
import type { BroadcastOperator, WsServer } from '@velajs/vela/websocket';

/**
 * Late-bound `WsServer`. Provided as `WS_SERVER` (one per DI container, i.e. per
 * Durable Object instance), then pointed at the ctx-backed server once the DO
 * builds. Gateways inject it via `@WebSocketServer()`; it throws if used before
 * a runtime binds it (e.g. from the stateless Worker isolate).
 */
@Injectable()
export class WsServerHolder implements WsServer {
  private target?: WsServer;
  private maxFrameBytes?: number;

  setTarget(server: WsServer): void {
    this.target = server;
    if (this.maxFrameBytes !== undefined) server.setOutboundFrameLimit?.(this.maxFrameBytes);
  }

  setOutboundFrameLimit(maxFrameBytes: number): void {
    const resolved = resolveMaxFrameBytes({ maxFrameBytes });
    this.maxFrameBytes =
      this.maxFrameBytes === undefined ? resolved : Math.max(this.maxFrameBytes, resolved);
    this.target?.setOutboundFrameLimit?.(this.maxFrameBytes);
  }

  private get resolved(): WsServer {
    if (!this.target) {
      throw new Error(
        'WebSocket server is only available inside a WebSocket Durable Object. To ' +
          'push from a Worker HTTP handler, use broadcastToRoom(namespace, gatewayPath, room, ...).',
      );
    }
    return this.target;
  }

  emit(event: string, data?: unknown): void | Promise<void> {
    return this.resolved.emit(event, data);
  }
  to(room: string): BroadcastOperator {
    return this.resolved.to(room);
  }
  in(room: string): BroadcastOperator {
    return this.resolved.in(room);
  }
  except(room: string): BroadcastOperator {
    return this.resolved.except(room);
  }
}
