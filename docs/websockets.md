# Vela WebSocket Module

NestJS-style WebSocket **gateways** for the Vela framework — one gateway API that runs on **Cloudflare Workers (Durable Objects)**, **Node.js**, **Bun**, and **Deno**. Built on Hono's own `upgradeWebSocket` (no Socket.IO, no `crossws`), with a raw-WebSocket JSON protocol, rooms, broadcasting, and full reuse of Vela's guards / pipes / interceptors / filters.

- **Core** (runtime-agnostic): `@velajs/vela/websocket`
- **Cloudflare transport** (Durable Object + hibernation): `@velajs/cloudflare`
- **Node / Bun / Deno transport** (+ Redis multi-instance): `@velajs/vela/websocket-node`

---

## The wire protocol

Every message is a JSON envelope:

```jsonc
{ "id": "optional-correlation-id", "event": "chat", "data": { "text": "hi" } }
```

- The server routes by `event` to the matching `@SubscribeMessage('event')` handler.
- A handler that returns a value replies to the **sender only**, echoing `id`. Return a `WsResponse` (`{ event, data }`) to control the reply event; return any other value to reply on the same `event`; return `undefined`/`void` for no reply.
- Errors are framed as `{ "event": "exception", "data": { ... } }`.
- Framework keepalive: send the reserved `{"event":"$ping"}` → the server replies `{"event":"$pong"}` (on Cloudflare this is answered *without waking* a hibernated Durable Object). Application gateways cannot register `$…` events.

Client side is just the browser `WebSocket`:

```js
const ws = new WebSocket('wss://example.com/rooms/general/ws');
ws.onmessage = (e) => { const { event, data } = JSON.parse(e.data); /* ... */ };
ws.onopen = () => ws.send(JSON.stringify({ event: 'chat', data: { text: 'hi' } }));
```

---

## Quick start — the gateway (same on every runtime)

```ts
// chat.gateway.ts
import { z } from 'zod';
import {
  WebSocketGateway, SubscribeMessage, MessageBody, ConnectedSocket, WebSocketServer, WsException,
} from '@velajs/vela/websocket';
import type { WsClient, WsServer, OnGatewayConnection, OnGatewayDisconnect } from '@velajs/vela/websocket';
import { ChatUpgradeAuthenticator } from './auth.js';

const chatMessage = z.object({ text: z.string().min(1).max(2000) });

@WebSocketGateway({
  path: '/rooms/:id/ws',
  roomParam: 'id',
  binding: 'CHAT_ROOM',
  authenticator: ChatUpgradeAuthenticator,
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  // Constructor injection only (the DI container has no property-injection pass).
  // This gateway's own server: its pushes reach only ChatGateway's sockets.
  constructor(@WebSocketServer() private readonly server: WsServer) {}

  handleConnection(client: WsClient) {
    return this.server.emit('system', { text: `${client.id.slice(0, 8)} joined` });
  }
  handleDisconnect(client: WsClient) {
    return this.server.emit('system', { text: `${client.id.slice(0, 8)} left` });
  }

  @SubscribeMessage('chat')
  async onChat(@MessageBody() input: unknown, @ConnectedSocket() client: WsClient) {
    const parsed = chatMessage.safeParse(input);
    if (!parsed.success) throw new WsException('Invalid chat message');
    const room = [...client.rooms][0];
    if (!room) throw new WsException('Missing chat room');
    await this.server.to(room).emit('chat', { from: client.id.slice(0, 8), text: parsed.data.text });
    return { event: 'ack', data: { ok: true } }; // WsResponse → replies to the sender
  }
}
```

Install `zod` for the message schema. `ChatUpgradeAuthenticator` is your
application's session or socket-ticket verifier, a class implementing
`UpgradeAuthenticator` from `@velajs/vela/websocket`. Its `authenticate` method
must verify the credential and access to the resolved room, then return
`{ principal, tenantId, expiresAtMs }` or `false`:

```ts
// auth.ts
import { Injectable } from '@velajs/vela';
import type {
  UpgradeAuthenticator,
  WebSocketUpgradeAuthenticationContext,
  WebSocketUpgradeIdentity,
} from '@velajs/vela/websocket';
import { SessionService } from './session.service.js';

@Injectable()
export class ChatUpgradeAuthenticator implements UpgradeAuthenticator {
  constructor(private readonly sessions: SessionService) {}

  async authenticate(
    request: Request,
    { room }: WebSocketUpgradeAuthenticationContext,
  ): Promise<WebSocketUpgradeIdentity | false> {
    const session = await this.sessions.fromCookie(request.headers.get('cookie'));
    if (!session?.rooms.includes(room)) return false;
    return {
      principal: { issuer: 'https://identity.example.com', subject: session.userId, principalType: 'user' },
      tenantId: session.tenantId,
      expiresAtMs: session.expiresAtMs,
    };
  }
}
```

Each application resolves the authenticator once, through dependency injection,
from the module that declares the gateway: a provider that module can see is
reused, and any other class, including one another module registers without
exporting it, is constructed with what that module can inject (here
`SessionService`, or `ENV` with `@InjectEnv()`). That one instance is built
once per application and authenticates every upgrade, so it must not be
request-scoped: an authenticator that declares `Scope.REQUEST`, or injects a
request-scoped provider such as `REQUEST_CONTEXT`, is a configuration error.
Read the upgrade request from the `request` argument of `authenticate()`. The
gateway declaration stays static; there is no closure-based authentication
option. `BetterAuthUpgradeAuthenticator` (`@velajs/better-auth`) and
`CloudflareAccessUpgradeAuthenticator` (`@velajs/cloudflare-access/vela`) are
ready-made authenticators. See [connection security](#connection-security) below.

`@WebSocketGateway(options)`:
- `path` — the route the upgrade is served on (supports params, e.g. `:id`).
- `binding` — **Cloudflare only**: the `wrangler.toml` Durable Object binding name that hosts this gateway's sockets. The Worker serves an upgrade route only for gateways that name one. Ignored on node/bun/deno.
- `roomParam` — the path parameter used as the room id. It is required for every parameterized path; bootstrap rejects missing or non-existent parameter names.
- `allowedOrigins` — browser Origin allowlist: an array of origins, or `(env) => origins`, which reads the application's `ENV` once per application (for example `(env) => [env.APP_ORIGIN]`). Omitted means same-origin; clients without an Origin header are allowed. Use `'*'` only as an explicit opt-out.
- `authorizeUpgrade(request)` — optional lightweight authentication/authorization hook that runs before socket allocation. It must return exactly `true`; errors fail closed.
- `authenticator` — the `UpgradeAuthenticator` class, required for successful connections. Its `authenticate(request, context)` receives the resolved room and optional short-lived `ticket`, and must return a canonical `{ principal, tenantId, expiresAtMs }` identity. A missing authenticator, `false`, an invalid result or a throwing `authenticate` refuses the upgrade with 403. An authenticator the declaring module cannot construct, or a request-scoped one, is a configuration error and answers 500.
- `authorizeDelivery(client)` — optional mutable authorization/revocation hook re-run for every server-initiated recipient. App-wide guards are also re-run; denial closes with 1008.
- `maxFrameBytes` — inbound and outbound frame ceiling, defaulting to 64 KiB. Oversized inbound frames close with code 1009 before JSON decoding; oversized replies, direct sends, and broadcasts close the affected recipient with 1009 without writing the frame.

Derived room ids are limited to 512 UTF-8 bytes and reject control characters
before transport allocation. A connection may join at most 32 rooms, including
its initial gateway room.

Handler parameter decorators:
- `@MessageBody()` — the envelope's `data`.
- `@ConnectedSocket()` — the `WsClient`.
- With **no** parameter decorators, a handler receives `(client, data)` positionally (NestJS convention).

Lifecycle interfaces: `OnGatewayInit` (`afterInit(server)`), `OnGatewayConnection` (`handleConnection(client)`), `OnGatewayDisconnect` (`handleDisconnect(client)`).

---

## `WsClient` and `WsServer`

```ts
interface WsClient<TData = Record<string, unknown>> {
  readonly id: string;                       // stable per-connection id
  readonly path?: string;                    // the gateway route path it connected through
  readonly rooms: ReadonlySet<string>;
  data: TData;                               // per-connection state (persisted on CF; call commit() after mutating)
  send(event: string, data?: unknown, id?: string): void;
  sendRaw(payload: string): void;            // escape hatch
  join(room: string): void | Promise<void>;
  leave(room: string): void | Promise<void>;
  commit(): void | Promise<void>;            // persist data/room changes (Cloudflare attachment)
  close(code?: number, reason?: string): void;
  readonly raw: unknown;                     // native socket (WSContext | Cloudflare WebSocket)
}

interface WsServer {                         // injected via @WebSocketServer()
  emit(event: string, data?: unknown): void | Promise<void>;   // every socket of the gateway
  to(room: string): BroadcastOperator;       // one room (chainable)
  in(room: string): BroadcastOperator;       // alias of to()
  except(room: string): BroadcastOperator;   // every socket of the gateway not in room
}
// BroadcastOperator: .to(room).in(room).except(room).emit(event, data)
```

Broadcasting builds a serializable `BroadcastCommand` (`{ rooms, exceptRooms?, exceptIds?, gatewayPath?, frame }`) handed to the active sync driver — so the same gateway code runs single-instance, on Cloudflare (Durable Object), or on Node with Redis, unchanged.

A gateway's `@WebSocketServer()` (or `@Inject(WS_SERVER)` in its constructor,
declared or inherited from a base class) is that gateway's own server: every
broadcast carries the gateway's path and is bounded by its `maxFrameBytes`, so
it reaches only the sockets connected through that gateway, even when another
gateway has a room with the same id. `afterInit(server)` receives the server
the injected handle pushes through, so pushes through either reach the same
sockets, but it is not the same object. `WS_SERVER` injected outside a
gateway addresses every gateway's sockets; push to one gateway's rooms with
`Gateways` instead.

`WebSocketModule` connects each gateway's server while the application starts,
before any lifecycle hook runs, from the `WS_SERVER` the gateway's module sees
when it sees exactly one (a provider with an async `useFactory` included).
When it sees none, or only the servers of several `WebSocketModule` instances
it imports, a `WebSocketModule` instance's own server serves the gateway. A
module that sees another module's `WS_SERVER` beside those is ambiguous:
bootstrap fails with an error that names each module providing one. A
`WS_SERVER` without `WebSocketModule` connects nothing: the gateway's server
then refuses each push with guidance. To push to a test double, keep `WebSocketModule.forRoot()`
imported and either provide `WS_SERVER` in the gateway's module or override it
in the testing module:

```ts
import { Test } from '@velajs/testing';
import { WS_SERVER, WebSocketModule } from '@velajs/vela/websocket';

const module = await Test.createTestingModule({
  imports: [WebSocketModule.forRoot()],
  providers: [ChatGateway],
})
  .overrideProvider(WS_SERVER)
  .useValue(recordingServer)
  .compile();
```

The double receives the gateway's `@WebSocketServer()` pushes. `Gateways`
pushes do not go through `WS_SERVER`: they reach the sockets through the
module's sync driver or the platform transport.

---

## Server push from anywhere: `Gateways`

A gateway's `@WebSocketServer()` reaches its own sockets in the isolate it
runs in. To push to a gateway's rooms from an HTTP handler, a queue consumer, a
cron job or another gateway, inject `Gateways` (provided and exported by
`WebSocketModule`) and name the gateway class. An explicit event map types
each push:

```ts
import { z } from 'zod';
import { Body, Controller, Param, Post, UseGuards } from '@velajs/vela';
import { Gateways } from '@velajs/vela/websocket';
import { ChatGateway } from './chat.gateway.js';
import { StaffGuard } from './staff.guard.js';

/** Each event the chat's rooms receive, and its payload. */
interface ChatEvents {
  chat: { from: string; text: string };
  system: { text: string };
}

const Announcement = z.object({ text: z.string().min(1).max(500) });

// The route pushes into any room its URL names: guard it with the
// application's own authorization, and validate the body before sending it on.
@Controller('/rooms')
@UseGuards(StaffGuard)
export class AnnouncementController {
  constructor(private readonly gateways: Gateways) {}

  @Post('/:id/announce')
  async announce(
    @Param('id') room: string,
    @Body(Announcement) body: z.infer<typeof Announcement>,
  ) {
    await this.gateways.of<ChatEvents>(ChatGateway).to(room).emit('system', { text: body.text });
    return { announced: room };
  }
}
```

`gateways.of<Events>(Gateway)` returns a `GatewayServer<Events>`: `to(room)`
(or `in(room)`) chains rooms, and `emit(event, data)` checks the event name
and payload against the map (an event whose payload admits `undefined` may
omit it). Without a type argument, any event and payload are accepted.

- The target comes from the gateway's `@WebSocketGateway` metadata: `path`,
  `binding` and `roomParam`. A room is a `roomParam` value; a gateway without
  `roomParam` admits every upgrade into one room, its path.
- A push reaches only that gateway's sockets, on every runtime. Two gateways
  may use the same room id, such as an organization id: a push to one
  gateway's room never reaches the other gateway's sockets. The push's
  `BroadcastCommand` carries the gateway path, and the in-memory and Durable
  Object room registries skip sockets whose `WsClient.path` differs. A custom
  `RoomRegistry` passed to `WebSocketModule.forRoot({ registry })` must apply
  the same filter in `deliverLocal`: one that ignores `cmd.gatewayPath`
  delivers every gateway-scoped push and broadcast to all gateways' sockets in
  the named rooms. A custom transport's `WsClient` must set `path` to its
  gateway's route: a socket without one receives no `Gateways` push and no
  broadcast from a gateway's `@WebSocketServer()`.
- Each push is bounded by that gateway's `maxFrameBytes` (default 64 KiB)
  before anything is resolved or sent.
- `emit()` without a room and `except()` throw with guidance: sockets live
  with their room, and a push reaches every socket in every room it names.
  Filter recipients with the gateway's `authorizeDelivery` option, which runs
  for each recipient before delivery.
- Without a platform transport that delivers pushes, `Gateways` dispatches
  each push through the module's sync driver: in-process hosts (node, Bun,
  Deno) deliver it to the gateway's sockets in this process, and `redis()`
  fans it out to the gateway's sockets on every instance.
- On Cloudflare, each room is a Durable Object. From the Worker, a push is a
  `broadcast` RPC to the gateway + room object, whose namespace is read by the
  gateway's `binding` from `ENV` when the push needs it. Inside a Durable
  Object, a push to its own room goes to its sockets, and a push to another
  room goes to that room's object. A gateway without a `binding` has no
  object to reach, so pushing to it fails with guidance.

A platform adapter supplies the delivery through the `WS_TRANSPORT` token:
`deliver(delivery)` receives one `GatewayDelivery` (`{ gatewayPath, binding?,
room, command }`) per room, and delivers the command to that gateway's
sockets. A transport that delivers pushes but builds no
server gives gateways a `@WebSocketServer()` that keeps no sockets and refuses
each push with guidance to `Gateways`. A transport that forwards upgrades
(`forwardUpgrade`) keeps a forwarded gateway's sockets (a gateway with a
`binding`) in another isolate. When it implements neither `deliver` nor
`createServer` and the sync driver is `local()`, nothing can reach them from
this process: a `Gateways` push to that gateway rejects with guidance, and its
`@WebSocketServer()` refuses each push the same way, instead of resolving
without reaching anyone. A cross-instance sync driver such as `redis()` may
reach the isolate that holds them, so with one both push paths hand it the
command.

A push that `deliver` carries to several gateway rooms settles every delivery
before it answers. When some fail, it rejects with an `AggregateError` whose
message names the failed rooms (`2 of 3 ChatGateway room pushes failed: "b",
"c"`; past ten, the first ten and how many more) and whose `errors` hold one
error per failed room, naming it, with the transport's error as its `cause`;
the other rooms received the push. A push delivered to one room (every push to
a gateway without `roomParam`) rejects with the transport's own error.

---

## Guards / pipes / interceptors / filters

Vela's existing pipeline is reused. A component that reads `getClass()`/`getHandler()` or calls `switchToWs()` works unchanged on both HTTP and WS.

```ts
import { Injectable } from '@velajs/vela';
import type { CanActivate, ExecutionContext } from '@velajs/vela';
import { normalizeWebSocketUpgradeIdentity } from '@velajs/vela/websocket';

@Injectable()
export class WsAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'ws') return true;
    const client = ctx.switchToWs().getClient();
    return normalizeWebSocketUpgradeIdentity(client.data) !== false;
  }
}
```

Apply `@UseGuards(WsAuthGuard)` (from `@velajs/vela`) to a gateway or handler.
The example checks the trusted identity installed by the gateway's authenticator;
add application-specific permission checks for protected actions. Never treat
identity fields supplied in a message body as authentication.

- `ExecutionContext.getType()` identifies the transport, including `'http'`, `'ws'`, and custom entrypoint kinds. On a WS context, `switchToHttp()` / `getRequest()` / `getContext()` **throw** (there is no HTTP request) — rewrite HTTP-request-reading guards to use `switchToWs().getClient()`.
- **Global components apply to gateways.** `APP_GUARD` / `APP_PIPE` / `APP_INTERCEPTOR` / `APP_FILTER` providers (and `app.useGlobalGuards()` etc.) run on WS messages, exactly as on HTTP routes — so an app-wide auth guard protects both transports.
- Throw `WsException(stringOrObject)` from a guard/handler to send a client-facing error frame. Register a `@Catch(WsException)` `ExceptionFilter` to customize it.
- **Note:** request-scoped (`Scope.REQUEST`) providers that depend on the HTTP request are not available in gateways.

### Connection security

Origin, `authorizeUpgrade` and authenticator checks run before the runtime upgrades the socket
(and, on Cloudflare, before resolving or allocating a Durable Object). Message
guards still run for every accepted frame. If `handleConnection` throws, the
transport closes with policy code 1008 and never dispatches queued messages.

The authenticator establishes a canonical principal, tenant, and finite
epoch-millisecond `expiresAtMs`. The transport stores that identity in
`client.data` (and the Cloudflare hibernation attachment). The dispatcher checks
it before every frame and server-initiated delivery, closing invalid or expired
identities with code 1008. Origin checks alone do not authenticate a connection.

#### Short-lived socket tickets

For browser flows that cannot attach an `Authorization` header, exchange the
normal authenticated HTTPS session for a room-bound, single-use socket ticket.
It may use the reserved `ticket` query parameter because its lifetime is at most
30 seconds and it is consumed once; Vela removes it before authorization
callbacks and Cloudflare Durable Object forwarding. Never put a Bearer token,
session token, API key, or other reusable credential in a WebSocket URL. Secure
same-site cookies plus Origin checks remain preferable when available.

```ts
import { Inject, Injectable, InjectEnv, type VelaEnv } from '@velajs/vela';
import { NONCE_STORE, type NonceStore } from '@velajs/vela/security';
import {
  WebSocketGateway,
  issueWebSocketTicket,
  verifyAndConsumeWebSocketTicket,
  type UpgradeAuthenticator,
  type WebSocketUpgradeAuthenticationContext,
} from '@velajs/vela/websocket';

// In the authenticated HTTPS handler that hands out the ticket:
const token = await issueWebSocketTicket({
  secret: env.SOCKET_TICKET_SECRET,
  gatewayPath: '/tenants/:tenantId/rooms/:room/ws',
  room: 'room:engineering',
  principal: {
    issuer: 'https://identity.example.com',
    subject: session.user.id,
    principalType: 'user',
  },
  tenantId: session.tenantId,
  ttlMs: 30_000,
});

@Injectable()
class RoomTicketAuthenticator implements UpgradeAuthenticator {
  constructor(
    @InjectEnv() private readonly env: VelaEnv,
    @Inject(NONCE_STORE) private readonly nonces: NonceStore,
  ) {}

  async authenticate(
    _request: Request,
    { ticket, gatewayPath, room }: WebSocketUpgradeAuthenticationContext,
  ) {
    if (!ticket) return false;
    return verifyAndConsumeWebSocketTicket(ticket, {
      secret: this.env.SOCKET_TICKET_SECRET,
      gatewayPath,
      room,
      nonceStore: this.nonces,
    });
  }
}

@WebSocketGateway({
  path: '/tenants/:tenantId/rooms/:room/ws',
  roomParam: 'room',
  authenticator: RoomTicketAuthenticator,
})
class RoomGateway {}
```

The HMAC claim has fixed `vela:websocket` / `socket-ticket`
audience-and-purpose tags and is bound to the declared gateway path, resolved
room, canonical principal, tenant, issue time, expiry, and generated nonce.
Lifetimes cannot exceed 30 seconds. Parsing is size-bounded and rejects unknown
fields; malformed, tampered, mismatched, future, expired, or replayed tokens
return `false`.

`NONCE_STORE` defaults to the per-isolate `MemoryNonceStore`, which is suitable
only for a single process/isolate. Strong single-use behavior across Cloudflare
isolates requires a structural `NonceStore` backed by a Durable Object (or
another store whose `claim` operation is atomic), such as
`durableObjectNonceStore()` from `@velajs/cloudflare` provided as `NONCE_STORE`.
The Node and Cloudflare transports persist the returned principal, tenant, and
`expiresAtMs` in connection state, then continue checking expiry and
authorization for frames and server-initiated delivery.

---

## Runtime setup

The gateway + module is identical; only the transport wiring differs.

### Cloudflare Workers (Durable Objects, hibernation)

```ts
// app.module.ts
import { Module } from '@velajs/vela';
import { WebSocketModule } from '@velajs/vela/websocket';
import { ChatGateway } from './chat.gateway.js';

@Module({
  imports: [WebSocketModule.forRoot()],
  providers: [ChatGateway],
})
export class AppModule {}
```

The module is the same one node, Bun and Deno use. The Cloudflare adapter,
which the Worker of `defineCloudflareApp` (or `createCloudflareWorker`) and
`VelaWebSocketDurableObject` register, supplies the platform through the global `WS_TRANSPORT` token: in the Worker,
`WebSocketModule` mounts an upgrade route for every gateway that names a
`binding` and forwards each authenticated upgrade to that room's Durable
Object; inside the Durable Object, the server gateways inject broadcasts to the
object's hibernatable sockets. A gateway's server has no sockets in the Worker
isolate, so pushes from there fail with guidance to `Gateways`, which reaches
each room's Durable Object (see [Server push from anywhere](#server-push-from-anywhere-gateways)).
Without `WebSocketModule`, the Worker mounts no upgrade route: its upgrades
answer 404, and the adapter reports each binding-backed gateway through the
diagnostics policy (a warning by default).

```ts
// Worker entry (src/index.ts)
import { defineCloudflareApp } from '@velajs/cloudflare';
import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';
import { AppModule } from './app.module.js';

// One app definition: the Worker and the room Durable Object share its root
// module and options. The DO class name must match wrangler `class_name`.
const app = defineCloudflareApp(AppModule);

export class ChatRoom extends VelaWebSocketDurableObject(app) {}

export default app.worker;
```

`VelaWebSocketDurableObject(AppModule)` builds the same class from a bare
root. The Worker and each Durable Object seed their native environment as the
framework `ENV`; the gateway resolves its `binding` by name from it. The room
object boots its application context like every Vela Durable Object (see
[Durable Objects](durable-objects.md)): it injects `DO_STATE`, `DO_STORAGE`
and `DO_ID`, and the app's runtime adapters configure it. Run
`wrangler types --include-runtime=false` so `worker-configuration.d.ts` types
`CHAT_ROOM` (and every other binding) on `VelaEnv` for code that injects `ENV`.

```toml
# wrangler.toml
main = "src/index.ts"
compatibility_date = "2024-11-06"
compatibility_flags = ["nodejs_als"]   # node:async_hooks for the vela root entry; see the caveats below

[[durable_objects.bindings]]
name = "CHAT_ROOM"
class_name = "ChatRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatRoom"]
```

How it works: the Worker's upgrade route validates the `Upgrade` header, removes client copies of the internal `x-vela-*` forwarding headers, resolves the room, runs the gateway's origin, authorization and authenticator checks, and forwards the request with the verified identity to the gateway + room Durable Object (a canonical namespace derived from the declared gateway path and room id). An identity that request middleware published with `setTrustedRequestIdentity` must match the authenticator's; the earlier expiry wins. The DO owns the raw socket via `WebSocketPair` + `ctx.acceptWebSocket(server, tags)` (hibernatable) and dispatches `webSocketMessage`/`webSocketClose`/`webSocketError` into the gateway. **One Durable Object per gateway room = native horizontal scale without cross-gateway room collisions.** Hono's `upgradeWebSocket` cannot bridge DO hibernation, which is why the DO uses the raw runtime API.

Server-initiated push from an HTTP controller, cron job or queue consumer
goes through `Gateways`: the Worker calls the `broadcast` RPC of the gateway +
room Durable Object, and a push from inside a Durable Object to another room is
forwarded the same way.

```ts
await this.gateways.of<ChatEvents>(ChatGateway).to(roomId).emit('chat', message);
```

### Node.js

```ts
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Module, VelaFactory } from '@velajs/vela';
import { WebSocketModule } from '@velajs/vela/websocket';
import { registerWebSocketGateways } from '@velajs/vela/websocket-node';
import { ChatGateway } from './chat.gateway.js';

@Module({ imports: [WebSocketModule.forRoot()], providers: [ChatGateway] })
class AppModule {}

const app = await VelaFactory.create(AppModule);
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: app.getHonoApp() });
registerWebSocketGateways(app, upgradeWebSocket);   // registers every @WebSocketGateway route
const server = serve({ fetch: app.fetch, port: 3000 });
injectWebSocket(server);
```

### Bun

```ts
import { createBunWebSocket } from 'hono/bun';
import { registerWebSocketGateways } from '@velajs/vela/websocket-node';

const app = await VelaFactory.create(AppModule);
const { upgradeWebSocket, websocket } = createBunWebSocket();
registerWebSocketGateways(app, upgradeWebSocket);
export default { fetch: app.fetch, websocket };
```

### Deno

```ts
import { upgradeWebSocket } from 'hono/deno';
import { registerWebSocketGateways } from '@velajs/vela/websocket-node';

const app = await VelaFactory.create(AppModule);
registerWebSocketGateways(app, upgradeWebSocket);
Deno.serve(app.fetch);
```

On node/bun/deno each connection auto-joins the room from the configured or derived route parameter (or the static route path), mirroring the Cloudflare DO-per-room model.

### Other platforms

A runtime adapter wires its platform by registering the global `WS_TRANSPORT`
token (a `WebSocketTransport`) in `configureContainer`, before modules load.
`createServer(driver)` builds the server gateways inject. A platform whose
sockets live in another isolate also implements `forwardUpgrade(upgrade)`:
`WebSocketModule` then mounts each binding-backed gateway's upgrade route,
authenticates the upgrade there and passes the request, gateway path, room,
binding and verified identity to it. Such a platform implements
`deliver(delivery)` as well, so that `Gateways` pushes reach the forwarded
sockets: with the `local()` sync driver, a forwarded gateway's pushes
otherwise reject, from `Gateways` and from its `@WebSocketServer()` alike. `forwardingHeaders` names the headers the
transport sets; the route removes client copies before any application hook
runs. The adapter never replaces the module's providers. An application
overrides the adapter's transport with a `@Global()` module that provides and
exports `WS_TRANSPORT`; the gateway server and the upgrade routes both use it.

---

## Multi-instance / horizontal scale

- **Cloudflare:** native. Each room is a globally-unique Durable Object (`idFromName(roomId)`); all its sockets live in one instance, so intra-room broadcast is a local fan-out with no cross-node hop.
- **Node / Bun (multiple processes):** add the Redis sync driver.

```ts
import Redis from 'ioredis';
import { redis } from '@velajs/vela/websocket-node';

WebSocketModule.forRoot({
  sync: redis({ pub: new Redis(url), sub: new Redis(url) }), // pub and sub MUST be separate connections
});
```

Delivery guarantees (honest): at-most-once, no ordering across publishers, no replay. The driver delivers locally first, then fans the command out on one broadcast channel; each instance filters to its own local room members and the command's gateway, and drops its own echo.

Upgrade every instance together. Instances running a release before gateway
scoping ignore a command's `gatewayPath`, so during a rolling upgrade a
gateway's push or broadcast reaches every gateway's sockets in the named rooms
on the instances that have not upgraded yet.

---

## Caveats & non-goals (v1)

- **Cloudflare needs `node:async_hooks`** — the `@velajs/vela` root entry statically imports `hono/context-storage`, even when ambient request access is off. The `nodejs_als` flag provides it. `nodejs_compat` includes it too and is on by default from compatibility date 2026-08-04, so only earlier dates need a flag. Neither `@velajs/cloudflare` nor the Durable Object WebSocket transport uses other Node.js APIs; `nodejs_compat` matters only when your code or another dependency imports further `node:*` modules.
- Cloudflare per-connection state (`client.data`, room membership) lives in the hibernation **attachment** — max **16 KiB**; store larger state in Durable Object storage keyed by `client.id`. Room membership survives hibernation; never keep it in DO instance fields.
- Inbound and outbound frames default to a **64 KiB** limit. The per-gateway value follows each connection through local or Redis fan-out and Cloudflare hibernation. Raise `maxFrameBytes` only after considering isolate memory, synchronization traffic, and validation cost.
- Protocol is **JSON text frames only** — binary frames and backpressure signalling are out of scope.
- Not yet implemented: cross-DO global `server.emit()` (push per room with `Gateways`), per-user-DO direct messages. On Cloudflare a `Gateways` push reaches the room's own Durable Object, so sockets of another room's object that joined the pushed room dynamically do not receive it.

## Admission and slow peers

`WsClient.trySendRaw(payload)` is an optional additive transport capability. It
returns `accepted`, `closed`, `too-large`, or `backpressure`. `accepted` means the
local transport accepted the frame; it is not an acknowledgment from the remote
application. Existing `send()` and `sendRaw()` remain `void`. Integrations can use
`trySendWebSocketFrame(client, payload)` to honor a connection's frame ceiling and
explicit rejection, with a fallback for legacy clients. Live-query baselines advance
only on local admission, so a refused snapshot is never treated as delivered.

Gateways may configure `sendPolicy: { maxBufferedBytes, maxBytesPerSecond }`.
Both budgets default to 1 MiB. Native `bufferedAmount`, when available, bounds the
queued bytes plus the next frame. A separate fixed one-second byte budget works
without timers on every adapter. Exceeding either budget closes with 1013; frames
above `maxFrameBytes` close with 1009. There is no outgoing retry queue. Cloudflare
does not guarantee a native queued-byte signal: its byte-rate budget bounds
admission, not hidden network buffers. Budgets restart after DO hibernation.
The live client accepts the same `sendPolicy` option and reconnects after closure.

Native adapters process each connection's messages in arrival order. Configure
`maxPendingMessages` (default 64) and `maxPendingBytes` (default 1 MiB) to bound
active plus queued work, including the Node connection-setup barrier. Overload
closes with 1013 and discards pending work; already-running work is allowed to
settle. Connections keep independent queues. No server timers are introduced.

Envelopes require an own string `event` and, when present, an own string `id`.
Payloads remain unknown until application validation runs. Extra fields remain
forward compatible, and existing empty string IDs stay valid. Malformed IDs no
longer reach handlers or appear in replies.

Hibernation attachments now carry `version: 1`; existing unversioned 1.x
attachments remain readable. Framework routing, rooms, identity field types and
connection state are validated before restoration or fanout. Unknown versions
and malformed records fail closed. Application `data` still needs its own schema;
a generic `WsClient<TData>` type is not runtime validation. Attachments retain the
16 KiB platform limit; use DO storage for larger state. Send queues and invocation
containers are never serialized.

### Invocation scope

Gateways default to singleton scope. Stack `@Injectable({ scope: Scope.REQUEST })`
with `@WebSocketGateway()` for a new gateway instance on each connection hook,
message, and disconnect hook. Keep durable connection state in `client.data`
and rooms; request-scoped gateway fields last for one invocation. `afterInit`
runs once for each resolved gateway instance before its callback runs.

A message's guards, body pipes, interceptors, exception filters, and gateway
resolve asynchronously in the same child container and retain their declaring
module's provider bindings. A rejected guard does not construct the request-scoped
gateway. `context.getContainer()` exposes that child; managed work registered
through its execution lifetime settles before request-scoped providers dispose.
No HTTP request context is synthesized for a socket callback. Body pipes prefer
the optional `transformAsync` entry point, so async schema transforms run once.

Reserved handlers receive the same invocation context as an optional fourth
argument. Live subscriptions and each refresh share a child between authorization
and resolver execution. Discovery includes request-scoped and lazy providers;
registering the same gateway or reserved handler in multiple module owners fails
instead of selecting an owner's dependencies implicitly. Live query names must
be unique across owners.

The browser live client uses private-use close codes `4009` (frame too large),
`4011` (send failure), and `4013` (send budget). Browser JavaScript cannot send
the corresponding reserved server codes through
[`WebSocket.close()`](https://websockets.spec.whatwg.org/#dom-websocket-close).
Local rejection enters reconnect even when a custom socket omits `onclose`.
