# WebSocket Gateways

Real-time gateways with a runtime-agnostic core (`@velajs/vela/websocket`, also re-exported from the main barrel) and pluggable transports. Same gateway code runs on Node/Bun/Deno and Cloudflare Durable Objects.

## Gateway basics

```ts
import {
  WebSocketGateway, SubscribeMessage, MessageBody, ConnectedSocket, WebSocketServer,
} from '@velajs/vela';
import type { WsClient, WsServer, OnGatewayConnection } from '@velajs/vela';

@WebSocketGateway({ path: '/chat' })
class ChatGateway implements OnGatewayConnection {
  @WebSocketServer() private readonly server!: WsServer;   // sugar for @Inject(WS_SERVER)

  handleConnection(client: WsClient) {
    client.join('lobby');
  }

  @SubscribeMessage('message')
  onMessage(@MessageBody() body: { text: string }, @ConnectedSocket() client: WsClient) {
    this.server.to('lobby').emit('message', { text: body.text, from: client.id });
    return { event: 'ack', data: true };   // WsResponse → framed back to the sender
  }
}
```

- `@WebSocketGateway({ path?, binding? })` — `path` is the upgrade route (supports `:params`, e.g. `/rooms/:id/ws`); `binding` is a Cloudflare-only Durable Object binding name (ignored elsewhere). The gateway is a singleton provider — register it in a module's `providers`.
- `@SubscribeMessage(event)` — handler for an inbound message event (stackable).
- `@MessageBody()` injects the message payload; `@ConnectedSocket()` injects the `WsClient`. With no param decorators a handler receives `(client, data)` positionally.
- `@WebSocketServer()` injects the `WsServer` for broadcasting.
- Returning a `WsResponse` (`{ event, data }`) frames a reply to the sender.

Gateway lifecycle interfaces: `OnGatewayInit` (`afterInit(server)`), `OnGatewayConnection` (`handleConnection(client)`), `OnGatewayDisconnect` (`handleDisconnect(client)`).

## Server, clients & rooms

`WsServer` (from `@WebSocketServer()`): `emit(event, data?)` broadcasts to everyone; `to(room)` / `in(room)` / `except(room)` return a chainable `BroadcastOperator` whose terminal `emit(event, data?)` targets rooms.

`WsClient`: `readonly rooms`, `join(room)` / `leave(room)`, `send(event, data?, id?)`, `close(code?, reason?)`, `commit()` (persist data/room changes — required for Cloudflare hibernation), `readonly raw`.

Throw `WsException(errorOrObject)` to send an `{ event: 'exception', data }` frame instead of crashing the socket.

## Module & sync driver

```ts
import { WebSocketModule } from '@velajs/vela';

@Module({ imports: [WebSocketModule.forRoot()], providers: [ChatGateway] })
class AppModule {}
```

`WebSocketModuleOptions`: `sync?` (cross-instance broadcast driver — defaults to `local()` for a single instance) and `registry?` (room registry — defaults to in-memory). Use a real sync driver for horizontal scale (Redis on Node, native per-room Durable Objects on Cloudflare). `WebSocketModule` stays eager (transports read gateway instances at wiring time).

## Transports

The gateway + module are identical across runtimes; you only choose the wiring:

| Runtime | Wiring | Sync |
|---|---|---|
| Node / Bun / Deno | `@velajs/vela/websocket-node` → `registerWebSocketGateways(app, upgradeWebSocket)` | `redis()` for multi-process |
| Cloudflare Workers | `@velajs/cloudflare` → `CloudflareWebSocketModule.forRoot()` + a `VelaWebSocketDurableObject(AppModule)` | native per-room Durable Object |

On Node/Bun/Deno, pass the runtime's Hono `upgradeWebSocket` factory (`@hono/node-ws`, `hono/bun`, or `hono/deno`); `registerWebSocketGateways` iterates `app.entrypoints.ofKind('websocket')` and mounts each gateway route (auto-joining the room from a `:id` path param). On Cloudflare, the Durable Object owns the raw socket via `WebSocketPair` + hibernation (`ctx.acceptWebSocket`), which Hono's `upgradeWebSocket` cannot bridge — one DO per room gives native horizontal scale.

For the full transport walkthrough, read the repo's `WEBSOCKET.md`.
