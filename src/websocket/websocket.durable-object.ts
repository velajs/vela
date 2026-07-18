import { DurableObject } from 'cloudflare:workers';
import type { Type } from '@velajs/vela';
import type { BroadcastCommand } from '@velajs/vela/websocket';
import type { CommitStamp, InvalidationCommand, LiveEngine } from '@velajs/vela/live';
import { buildDoRuntime } from './do-bootstrap';
import { DoWebSocketHost, type WsConnectionPrincipal } from './do-websocket-host';
import type { WsLike } from './do-state';

const PING = '{"event":"ping"}';
const PONG = '{"event":"pong"}';
const MAX_IDENTITY_FIELD_BYTES = 2048;
const encoder = new TextEncoder();

function isIdentityField(value: string | null): value is string {
  return (
    value !== null &&
    value.length > 0 &&
    encoder.encode(value).byteLength <= MAX_IDENTITY_FIELD_BYTES
  );
}

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
): new (
  ctx: DurableObjectState,
  env: Record<string, unknown>,
) => DurableObject<Record<string, unknown>> {
  return class VelaWsDurableObject extends DurableObject<Record<string, unknown>> {
    private host!: DoWebSocketHost;
    private liveEngine?: LiveEngine;
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
        this.host = new DoWebSocketHost(
          ctx,
          runtime.dispatcher,
          runtime.registry,
          runtime.gatewayPaths,
        );
        this.liveEngine = runtime.live;
      });
    }

    override async fetch(request: Request): Promise<Response> {
      await this.ready;
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const url = new URL(request.url);
      // Headers are primary (carry auth + multi-gateway routing); fall back to the
      // DO's own name (set via idFromName(room)) and the single gateway path so a
      // plain `stub.fetch(request)` forward still works.
      const roomId = request.headers.get('x-vela-room') ?? this.ctx.id.name ?? url.pathname;
      const path = request.headers.get('x-vela-path') ?? this.host.defaultPath() ?? url.pathname;
      const userId = request.headers.get('x-vela-user') || undefined;
      const rawExpiresAtMs = request.headers.get('x-vela-expires-at-ms');
      const parsedExpiresAtMs = rawExpiresAtMs === null ? undefined : Number(rawExpiresAtMs);
      if (
        parsedExpiresAtMs !== undefined &&
        (!Number.isSafeInteger(parsedExpiresAtMs) || parsedExpiresAtMs <= 0)
      ) {
        return new Response('Invalid WebSocket identity expiry', { status: 403 });
      }

      const issuer = request.headers.get('x-vela-issuer');
      const subject = request.headers.get('x-vela-subject');
      const principalType = request.headers.get('x-vela-principal-type');
      const tenantId = request.headers.get('x-vela-tenant');
      const hasPrincipalHeader =
        issuer !== null || subject !== null || principalType !== null || tenantId !== null;
      let principal: WsConnectionPrincipal | undefined;
      if (hasPrincipalHeader) {
        if (
          !isIdentityField(issuer) ||
          !isIdentityField(subject) ||
          (principalType !== 'user' && principalType !== 'service') ||
          !isIdentityField(tenantId) ||
          parsedExpiresAtMs === undefined ||
          (userId !== undefined && userId !== subject)
        ) {
          return new Response('Invalid WebSocket principal', { status: 403 });
        }
        principal = { issuer, subject, principalType, tenantId };
      } else if (parsedExpiresAtMs !== undefined) {
        return new Response('WebSocket identity tuple is missing', { status: 403 });
      }

      if (parsedExpiresAtMs !== undefined && parsedExpiresAtMs <= Date.now()) {
        return new Response('WebSocket identity expired', { status: 403 });
      }

      const { 0: client, 1: server } = new WebSocketPair();
      const accepted = await this.host.accept(
        server as unknown as WsLike,
        path,
        roomId,
        userId,
        parsedExpiresAtMs,
        principal,
      );
      if (!accepted) return new Response('WebSocket connection rejected', { status: 403 });
      return new Response(null, { status: 101, webSocket: client });
    }

    override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      await this.ready;
      await this.host.onMessage(ws as unknown as WsLike, message);
    }

    override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
      await this.ready;
      await this.host.onClose(ws as unknown as WsLike, code, reason);
    }

    override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
      await this.ready;
      await this.host.onError(ws as unknown as WsLike, error);
    }

    /** DO RPC — server-initiated broadcast forwarded from a Worker (see `broadcastToRoom`). */
    async broadcast(cmd: BroadcastCommand): Promise<void> {
      await this.ready;
      await this.host.broadcast(cmd);
    }

    /**
     * DO RPC — live tag invalidation forwarded from a Worker (durableObjectLive /
     * liveInvalidateToRoom). Appends to THIS log scope's cursor log and returns
     * the commit stamp (what `Vela-Commit-Cursor` carries); the subscription
     * refreshes fan out asynchronously.
     */
    async invalidate(cmd: InvalidationCommand): Promise<CommitStamp | undefined> {
      await this.ready;
      return this.liveEngine?.applyInvalidation(cmd);
    }
  };
}
