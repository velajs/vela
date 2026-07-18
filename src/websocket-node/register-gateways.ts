import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { UpgradeWebSocket, WSMessageReceive } from 'hono/ws';
import type { VelaApplication } from '../application';
import {
  authenticateWebSocketUpgrade,
  resolveMaxFrameBytes,
  resolveGatewayRoomId,
  WS_ROOM_REGISTRY,
} from '../websocket/index';
import type { RoomRegistry, WsEntrypointMeta } from '../websocket/index';
import { NodeWsClient } from './node-ws-client';

function toFrame(data: WSMessageReceive): string | ArrayBuffer | undefined {
  if (typeof data === 'string') return data;
  // Keep binary frames encoded until WsDispatcher enforces maxFrameBytes.
  // Decoding first would allocate attacker-controlled input before the limit.
  if (data instanceof ArrayBuffer) return data;
  // Blob / SharedArrayBuffer — binary is out of scope for the JSON envelope protocol.
  return undefined;
}

/**
 * Registers every `@WebSocketGateway` on the app's Hono instance using the
 * runtime's Hono `upgradeWebSocket` factory — the same call works on node
 * (`@hono/node-ws` / `@hono/node-server` v2), Bun (`hono/bun`), and Deno
 * (`hono/deno`). Each connection auto-joins the room from the gateway's
 * configured/derived route parameter (or the static route path), mirroring the
 * Cloudflare DO-per-room model.
 *
 * @example
 * ```ts
 * // Node
 * const app = await VelaFactory.create(AppModule);
 * const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: app.getHonoApp() });
 * registerWebSocketGateways(app, upgradeWebSocket);
 * const server = serve({ fetch: app.fetch, port: 3000 });
 * injectWebSocket(server);
 * ```
 */
export function registerWebSocketGateways(
  app: VelaApplication,
  upgradeWebSocket: UpgradeWebSocket,
): void {
  const hono = app.getHonoApp();
  const registry = app.get(WS_ROOM_REGISTRY) as RoomRegistry;

  const deliveryDispatcher =
    app.entrypoints.ofKind<WsEntrypointMeta>('websocket')[0]?.meta.dispatcher;
  if (deliveryDispatcher) {
    registry.setDeliveryAuthorizer?.((client) => {
      const path = (client as NodeWsClient).path;
      return deliveryDispatcher.authorizeDelivery(path, client);
    });
  }

  for (const { meta } of app.entrypoints.ofKind<WsEntrypointMeta>('websocket')) {
    const { path, dispatcher, options } = meta;
    hono.get(
      path,
      upgradeWebSocket(async (c: Context) => {
        let roomId: string;
        try {
          roomId = resolveGatewayRoomId(options, (name) => c.req.param(name));
        } catch {
          throw new HTTPException(400, { message: 'Invalid WebSocket room' });
        }
        const upgrade = await authenticateWebSocketUpgrade(options, c.req.raw, roomId);
        if (upgrade === false) {
          throw new HTTPException(403, { message: 'WebSocket upgrade forbidden' });
        }
        let client: NodeWsClient;
        // Connection-setup barrier: messages queue behind join + handleConnection
        // so an auth check in handleConnection runs before any message dispatches.
        let ready: Promise<boolean> = Promise.resolve(false);
        const reportError = (err: unknown) => {
          if (client) void dispatcher.handleError(path, client, err).catch(() => {});
        };
        const failSetup = (err: unknown): false => {
          reportError(err);
          try {
            client.close(1008, 'Connection rejected');
          } catch {
            // already closed
          }
          registry.leaveAll(client);
          return false;
        };
        return {
          onOpen: (_evt, ws) => {
            client = new NodeWsClient(ws, registry, path, resolveMaxFrameBytes(options));
            client.data = {
              principal: { ...upgrade.identity.principal },
              tenantId: upgrade.identity.tenantId,
              expiresAtMs: upgrade.identity.expiresAtMs,
              userId: upgrade.identity.principal.subject,
            };
            registry.register(client);
            ready = Promise.resolve(client.join(roomId))
              .then(() => dispatcher.handleOpen(path, client))
              .then(() => true)
              .catch(failSetup);
          },
          onMessage: (evt) => {
            const frame = toFrame(evt.data);
            if (frame === undefined) return;
            void ready
              .then((accepted) =>
                accepted ? dispatcher.dispatchMessage(path, client, frame) : undefined,
              )
              .catch(reportError);
          },
          onClose: (evt) => {
            const code = (evt as CloseEvent).code || 1000;
            const reason = (evt as CloseEvent).reason || '';
            void Promise.resolve(dispatcher.handleClose(path, client, code, reason))
              .catch(reportError)
              .finally(() => registry.leaveAll(client));
          },
          onError: (evt) => {
            reportError(evt);
          },
        };
      }),
    );
  }
}
