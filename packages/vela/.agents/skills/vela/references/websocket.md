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
  // Constructor injection only; sugar for @Inject(WS_SERVER). This gateway's own server.
  constructor(@WebSocketServer() private readonly server: WsServer) {}

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
- `@WebSocketServer()` (or `@Inject(WS_SERVER)` in a gateway's constructor, declared or inherited) injects the gateway's own `WsServer`: its broadcasts carry the gateway path and reach only this gateway's sockets in the current isolate, even when another gateway uses the same room id; `afterInit(server)` receives the same server. `WS_SERVER` injected outside a gateway addresses every gateway's sockets. To push from anywhere else (HTTP handlers, queue consumers, crons, another gateway), inject `Gateways`.
- Test a gateway's pushes against a double by providing `WS_SERVER` in the gateway's module next to `WebSocketModule.forRoot()` or by overriding `WS_SERVER` in the testing module; without `WebSocketModule` the gateway's server refuses each push.
- Returning a `WsResponse` (`{ event, data }`) frames a reply to the sender.

Gateway lifecycle interfaces: `OnGatewayInit` (`afterInit(server)`), `OnGatewayConnection` (`handleConnection(client)`), `OnGatewayDisconnect` (`handleDisconnect(client)`).

## Server, clients & rooms

`WsServer` (from `@WebSocketServer()`): `emit(event, data?)` broadcasts to every socket of the gateway; `to(room)` / `in(room)` / `except(room)` return a chainable `BroadcastOperator` whose terminal `emit(event, data?)` targets rooms.

`WsClient`: `readonly path?` (the gateway route it connected through; a custom transport's client must set it, or the socket receives no `Gateways` push and no gateway `@WebSocketServer()` broadcast), `readonly rooms`, `join(room)` / `leave(room)`, `send(event, data?, id?)`, `close(code?, reason?)`, `commit()` (persist data/room changes — required for Cloudflare hibernation), `readonly raw`.

Throw `WsException(errorOrObject)` to send an `{ event: 'exception', data }` frame instead of crashing the socket.

## Server push: `Gateways`

```ts
import { Body, Controller, Param, Post, UseGuards } from '@velajs/vela';
import { Gateways } from '@velajs/vela/websocket';
import { z } from 'zod';

interface ChatEvents { message: { from: string; text: string } } // event → payload
const Announcement = z.object({ text: z.string().min(1).max(500) });

@Controller('/rooms')
@UseGuards(StaffGuard) // the app's own authorization: this route pushes into any room it names
class RoomsController {
  constructor(private readonly gateways: Gateways) {} // from @velajs/vela/websocket

  @Post('/:id/announce')
  announce(@Param('id') id: string, @Body(Announcement) body: z.infer<typeof Announcement>) {
    return this.gateways.of<ChatEvents>(ChatGateway).to(id).emit('message', { from: 'system', text: body.text });
  }
}
```

`gateways.of<Events>(Gateway)` returns a `GatewayServer<Events>` built from the gateway's metadata (`path`, `binding`, `roomParam`); `to(room)`/`in(room)` chain rooms and `emit(event, data)` is typed by the event map and bounded by the gateway's `maxFrameBytes`. `emit()` without a room and `except()` throw with guidance. A push reaches only that gateway's sockets on every runtime, even when another gateway uses the same room id: the command carries the gateway path and registries skip sockets whose `WsClient.path` differs. Without a delivering transport, pushes go through the module's sync driver (in-process hosts; `redis()` across instances); on Cloudflare the Worker calls the gateway + room Durable Object's `broadcast` RPC (namespace read by `binding` from `ENV`), and inside a Durable Object its own room is local while other rooms are forwarded. A gateway without `roomParam` has one room: its path.

## Module & sync driver

```ts
import { WebSocketModule } from '@velajs/vela/websocket';

@Module({ imports: [WebSocketModule.forRoot()], providers: [ChatGateway] })
class AppModule {}
```

`WebSocketModuleOptions`: `sync?` (cross-instance broadcast driver — defaults to `local()` for a single instance) and `registry?` (room registry — defaults to in-memory). Use a real sync driver for horizontal scale (Redis on Node, native per-room Durable Objects on Cloudflare). A custom `registry` must skip sockets whose `WsClient.path` differs from `cmd.gatewayPath` in `deliverLocal`, or gateway pushes leak across gateways that share a room id. Upgrade every `redis()` instance together: older instances ignore `gatewayPath` and deliver to every gateway's sockets in the room. `WebSocketModule` stays eager; transport discovery reads owner-bearing metadata without constructing request gateways.

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

On Node/Bun/Deno, pass the runtime's Hono `upgradeWebSocket` factory (`@hono/node-ws`, `hono/bun`, or `hono/deno`); `registerWebSocketGateways` iterates `app.entrypoints.ofKind('websocket')` and mounts each gateway route (auto-joining the room from a `:id` path param). On Cloudflare, the Worker mounts an upgrade route for each gateway naming a `binding`, authenticates the upgrade, and forwards it to the gateway + room Durable Object, which owns the raw socket via `WebSocketPair` + hibernation (`ctx.acceptWebSocket`), which Hono's `upgradeWebSocket` cannot bridge — one DO per room gives native horizontal scale. The Worker's `@WebSocketServer()` has no sockets and throws on push with guidance to `Gateways`. Other runtime adapters wire a platform the same way: register a `WebSocketTransport` as the global `WS_TRANSPORT` (`createServer(driver)`; `deliver(delivery)` for `Gateways` pushes to another isolate, each to the gateway's sockets — without `createServer` the injected server then refuses pushes; `forwardUpgrade` + `forwardingHeaders` when sockets live in another isolate).

For the full transport walkthrough, read the repo's `docs/websockets.md`.
