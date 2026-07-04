import { DurableObject } from 'cloudflare:workers';
import type { Type } from '@velajs/vela';
import type { BroadcastCommand } from '@velajs/vela/websocket';
import { buildDoRuntime } from './do-bootstrap';
import { DoWebSocketHost } from './do-websocket-host';
import type { WsLike } from './do-state';

const PING = '{"event":"ping"}';
const PONG = '{"event":"pong"}';

/**
 * Base class for the WebSocket Durable Object. The user exports a named subclass
 * (matching their `wrangler.toml` `class_name`) built from their `AppModule`:
 *
 * ```ts
 * export class ChatRoom extends VelaWebSocketDurableObject(AppModule) {}
 * ```
 *
 * It owns the raw hibernation socket lifecycle (Hono's `upgradeWebSocket` cannot
 * bridge DO hibernation) and forwards every event into the runtime-agnostic
 * `WsDispatcher` via {@link DoWebSocketHost}.
 */
export function VelaWebSocketDurableObject(
  rootModule: Type,
): new (ctx: DurableObjectState, env: Record<string, unknown>) => DurableObject<Record<string, unknown>> {
  return class VelaWsDurableObject extends DurableObject<Record<string, unknown>> {
    private host!: DoWebSocketHost;
    private readonly ready: Promise<void>;

    constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
      super(ctx, env);
      // Application-level ping/pong answered WITHOUT waking a hibernated DO.
      try {
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
      } catch {
        // Older runtimes without auto-response — fine, protocol pings still work.
      }
      this.ready = ctx.blockConcurrencyWhile(async () => {
        const runtime = await buildDoRuntime(rootModule, ctx, env);
        this.host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry, runtime.gatewayPaths);
      });
    }

    async fetch(request: Request): Promise<Response> {
      await this.ready;
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const { 0: client, 1: server } = new WebSocketPair();
      const url = new URL(request.url);
      // Headers are primary (carry auth + multi-gateway routing); fall back to the
      // DO's own name (set via idFromName(room)) and the single gateway path so a
      // plain `stub.fetch(request)` forward still works.
      const roomId = request.headers.get('x-vela-room') ?? this.ctx.id.name ?? url.pathname;
      const path = request.headers.get('x-vela-path') ?? this.host.defaultPath() ?? url.pathname;
      const userId = request.headers.get('x-vela-user') || undefined;

      this.host.accept(server as unknown as WsLike, path, roomId, userId);
      return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      await this.ready;
      await this.host.onMessage(ws as unknown as WsLike, message);
    }

    async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
      await this.ready;
      await this.host.onClose(ws as unknown as WsLike, code, reason);
    }

    async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
      await this.ready;
      await this.host.onError(ws as unknown as WsLike, error);
    }

    /** DO RPC — server-initiated broadcast forwarded from a Worker (see `broadcastToRoom`). */
    async broadcast(cmd: BroadcastCommand): Promise<void> {
      await this.ready;
      this.host.broadcast(cmd);
    }
  };
}
