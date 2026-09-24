# WebSocket Gateways

Real-time gateways with a runtime-agnostic core (`@velajs/vela/websocket`, the only import path for gateways; `@velajs/cloudflare` does not re-export them) and pluggable transports. Same gateway code runs on Node/Bun/Deno and Cloudflare Durable Objects.

## Gateway basics

```ts
import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
} from '@velajs/vela/websocket';
import type { WsClient, WsServer, OnGatewayConnection } from '@velajs/vela/websocket';

@WebSocketGateway({ path: '/chat' })
class ChatGateway implements OnGatewayConnection {
  constructor(@WebSocketServer() private readonly server: WsServer) {} // @Inject(WS_SERVER)

  handleConnection(client: WsClient) {
    client.join('lobby');
  }

  @SubscribeMessage('message')
  onMessage(@MessageBody() input: unknown, @ConnectedSocket() client: WsClient) {
    const body = MessageSchema.parse(input); // application schema validates the wire payload
    this.server.to('lobby').emit('message', { text: body.text, from: client.id });
    return { event: 'ack', data: true };   // WsResponse → framed back to the sender
  }
}
```

- `@WebSocketGateway({ path?, binding? })` — `path` is the upgrade route (supports `:params`, e.g. `/rooms/:id/ws`); `binding` is a Cloudflare-only Durable Object binding name (ignored elsewhere). Register the gateway in module `providers`. It defaults to singleton scope; stack `@Injectable({ scope: Scope.REQUEST })` for invocation-local state.
- Upgrades fail closed until the gateway names `authenticator: SomeAuthenticator`, a class implementing `UpgradeAuthenticator` (`authenticate(request, { gatewayPath, room, ticket? })` → `{ principal, tenantId, expiresAtMs }` or `false`). Each application resolves it once through DI from the module that declares the gateway, so it may inject that module's providers. Ready-made: `BetterAuthUpgradeAuthenticator` (`@velajs/better-auth`, tenant from the active organization or a `BETTER_AUTH_UPGRADE_TENANT` resolver) and `CloudflareAccessUpgradeAuthenticator` (`@velajs/cloudflare-access/vela`). `allowedOrigins` takes origins or `(env) => origins`, read from `ENV` once per application; there is no closure-based authentication option.
- `@SubscribeMessage(event)` — handler for an inbound message event (stackable).
- `@MessageBody()` injects an unknown wire payload; validate it with a pipe or schema before use; `@ConnectedSocket()` injects the `WsClient`. With no param decorators a handler receives `(client, data)` positionally.
- `@WebSocketServer()` injects the `WsServer` for broadcasting.
- Returning a `WsResponse` (`{ event, data }`) frames a reply to the sender.

Gateway lifecycle interfaces: `OnGatewayInit` (`afterInit(server)`), `OnGatewayConnection` (`handleConnection(client)`), `OnGatewayDisconnect` (`handleDisconnect(client)`).

## Server, clients & rooms

`WsServer` (from `@WebSocketServer()`): `emit(event, data?)` broadcasts to everyone; `to(room)` / `in(room)` / `except(room)` return a chainable `BroadcastOperator` whose terminal `emit(event, data?)` targets rooms.

`WsClient`: `readonly rooms`, `join(room)` / `leave(room)`, `send(event, data?, id?)`, `close(code?, reason?)`, `commit()` (persist data/room changes — required for Cloudflare hibernation), `readonly raw`.

Throw `WsException(errorOrObject)` to send an `{ event: 'exception', data }` frame instead of crashing the socket.

## Module & sync driver

```ts
import { WebSocketModule } from '@velajs/vela/websocket';

@Module({ imports: [WebSocketModule.forRoot()], providers: [ChatGateway] })
class AppModule {}
```

`WebSocketModuleOptions`: `sync?` (cross-instance broadcast driver — defaults to `local()` for a single instance) and `registry?` (room registry — defaults to in-memory). Use a real sync driver for horizontal scale (Redis on Node, native per-room Durable Objects on Cloudflare). `WebSocketModule` stays eager; transport discovery reads owner-bearing metadata without constructing request gateways.

Each handler invocation gets a managed child with the gateway's module owner;
scoped guards/components and asynchronous providers use that child. Guards run
before request-scoped gateway construction. Connection/room state belongs on
the authenticated client or durable attachment; it does not survive in a
request-scoped gateway instance. Socket invocations do not acquire HTTP
`REQUEST_CONTEXT` or authority from frame payloads.

Validate complete envelopes and correlation IDs. Configurable send admission
limits bound local queued bytes and rates; rejection does not mean delivery.
Live baselines advance only after local send acceptance. Native attachment
validation and browser-valid closure/reconnect behavior preserve these limits
through hibernation and setup failure.

## Transports

The gateway + module are identical across runtimes; you only choose the wiring:

| Runtime | Wiring | Sync |
|---|---|---|
| Node / Bun / Deno | `@velajs/vela/websocket-node` → `registerWebSocketGateways(app, upgradeWebSocket)` | `redis()` for multi-process |
| Cloudflare Workers | the same `WebSocketModule.forRoot()`; `createCloudflareWorker` and a `VelaWebSocketDurableObject(AppModule)` from `@velajs/cloudflare/durable-objects` register the platform (`WS_TRANSPORT`), and each seeds its own `ENV` | native per-room Durable Object |

On Node/Bun/Deno, pass the runtime's Hono `upgradeWebSocket` factory (`@hono/node-ws`, `hono/bun`, or `hono/deno`); `registerWebSocketGateways` iterates `app.entrypoints.ofKind('websocket')` and mounts each gateway route (auto-joining the room from a `:id` path param). On Cloudflare, the Worker mounts an upgrade route for each gateway naming a `binding`, authenticates the upgrade, and forwards it to the gateway + room Durable Object, which owns the raw socket via `WebSocketPair` + hibernation (`ctx.acceptWebSocket`), which Hono's `upgradeWebSocket` cannot bridge — one DO per room gives native horizontal scale. The Worker's `@WebSocketServer()` has no sockets and throws on push; use `broadcastToRoom`. Other runtime adapters wire a platform the same way: register a `WebSocketTransport` as the global `WS_TRANSPORT` (`createServer(driver)`; `forwardUpgrade` + `forwardingHeaders` when sockets live in another isolate).

For the full transport walkthrough, read the repo's `docs/websockets.md`.
