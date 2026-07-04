import type { Context } from 'hono';
import type { UpgradeWebSocket, WSMessageReceive } from 'hono/ws';
import type { VelaApplication } from '../application';
import { WS_ROOM_REGISTRY } from '../websocket/index';
import type { RoomRegistry, WsEntrypointMeta } from '../websocket/index';
import { NodeWsClient } from './node-ws-client';

function toText(data: WSMessageReceive): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  // Blob / SharedArrayBuffer — binary is out of scope for the JSON envelope protocol.
  return undefined;
}

/**
 * Registers every `@WebSocketGateway` on the app's Hono instance using the
 * runtime's Hono `upgradeWebSocket` factory — the same call works on node
 * (`@hono/node-ws` / `@hono/node-server` v2), Bun (`hono/bun`), and Deno
 * (`hono/deno`). Each connection auto-joins the room from a `:id` route param
 * (or the route path), mirroring the Cloudflare DO-per-room model.
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

  for (const { meta } of app.entrypoints.ofKind<WsEntrypointMeta>('websocket')) {
    const { path, dispatcher } = meta;
    hono.get(
      path,
      upgradeWebSocket((c: Context) => {
        const roomId = c.req.param('id') ?? path;
        let client: NodeWsClient;
        // Connection-setup barrier: messages queue behind join + handleConnection
        // so an auth check in handleConnection runs before any message dispatches.
        let ready: Promise<unknown> = Promise.resolve();
        const onSetupError = (err: unknown) => {
          void dispatcher.handleError(path, client, err);
        };
        return {
          onOpen: (_evt, ws) => {
            client = new NodeWsClient(ws, registry, path);
            registry.register(client);
            ready = Promise.resolve(client.join(roomId))
              .then(() => dispatcher.handleOpen(path, client))
              .catch(onSetupError);
          },
          onMessage: (evt) => {
            const text = toText(evt.data);
            if (text === undefined) return;
            void ready.then(() => dispatcher.dispatchMessage(path, client, text)).catch(onSetupError);
          },
          onClose: (evt) => {
            const code = (evt as CloseEvent).code || 1000;
            const reason = (evt as CloseEvent).reason || '';
            void Promise.resolve(dispatcher.handleClose(path, client, code, reason))
              .catch(onSetupError)
              .finally(() => registry.leaveAll(client));
          },
          onError: (evt) => {
            void dispatcher.handleError(path, client, evt);
          },
        };
      }),
    );
  }
}
