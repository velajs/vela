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
import { authenticateChatUpgrade } from './auth.js';

const chatMessage = z.object({ text: z.string().min(1).max(2000) });

@WebSocketGateway({
  path: '/rooms/:id/ws',
  roomParam: 'id',
  binding: 'CHAT_ROOM',
  authenticateUpgrade: authenticateChatUpgrade,
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  // Constructor injection only (the DI container has no property-injection pass).
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

Install `zod` for the message schema. `authenticateChatUpgrade` is your application's
session or socket-ticket verifier: it must verify the credential and access to the
resolved room, then return `{ principal, tenantId, expiresAtMs }` or `false`.
Its type is `NonNullable<WebSocketGatewayOptions['authenticateUpgrade']>` from
`@velajs/vela/websocket`. See [connection security](#connection-security) below.

`@WebSocketGateway(options)`:
- `path` — the route the upgrade is served on (supports params, e.g. `:id`).
- `binding` — **Cloudflare only**: the `wrangler.toml` Durable Object binding name that hosts this gateway's sockets. Ignored on node/bun/deno.
- `roomParam` — the path parameter used as the room id. It is required for every parameterized path; bootstrap rejects missing or non-existent parameter names.
- `allowedOrigins` — browser Origin allowlist. Omitted means same-origin; clients without an Origin header are allowed. Use `'*'` only as an explicit opt-out.
- `authorizeUpgrade(request)` — optional lightweight authentication/authorization hook that runs before socket allocation. It must return exactly `true`; errors fail closed.
- `authenticateUpgrade(request, context)` — required for successful connections. It receives the resolved room and optional short-lived `ticket`, and must return a canonical `{ principal, tenantId, expiresAtMs }` identity. Missing authenticators, invalid results, and errors fail closed.
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
  emit(event: string, data?: unknown): void | Promise<void>;   // everyone (global)
  to(room: string): BroadcastOperator;       // one room (chainable)
  in(room: string): BroadcastOperator;       // alias of to()
  except(room: string): BroadcastOperator;   // everyone not in room
}
// BroadcastOperator: .to(room).in(room).except(room).emit(event, data)
```

Broadcasting builds a serializable `BroadcastCommand` (`{ rooms, exceptRooms?, exceptIds?, frame }`) handed to the active sync driver — so the same gateway code runs single-instance, on Cloudflare (Durable Object), or on Node with Redis, unchanged.

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
The example checks the trusted identity installed by `authenticateUpgrade`;
add application-specific permission checks for protected actions. Never treat
identity fields supplied in a message body as authentication.

- `ExecutionContext.getType()` identifies the transport, including `'http'`, `'ws'`, and custom entrypoint kinds. On a WS context, `switchToHttp()` / `getRequest()` / `getContext()` **throw** (there is no HTTP request) — rewrite HTTP-request-reading guards to use `switchToWs().getClient()`.
- **Global components apply to gateways.** `APP_GUARD` / `APP_PIPE` / `APP_INTERCEPTOR` / `APP_FILTER` providers (and `app.useGlobalGuards()` etc.) run on WS messages, exactly as on HTTP routes — so an app-wide auth guard protects both transports.
- Throw `WsException(stringOrObject)` from a guard/handler to send a client-facing error frame. Register a `@Catch(WsException)` `ExceptionFilter` to customize it.
- **Note:** request-scoped (`Scope.REQUEST`) providers that depend on the HTTP request are not available in gateways.

### Connection security

Origin, `authorizeUpgrade`, and `authenticateUpgrade` checks run before the runtime upgrades the socket
(and, on Cloudflare, before resolving or allocating a Durable Object). Message
guards still run for every accepted frame. If `handleConnection` throws, the
transport closes with policy code 1008 and never dispatches queued messages.

`authenticateUpgrade` establishes a canonical principal, tenant, and finite
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
import { MemoryNonceStore } from '@velajs/vela';
import {
  issueWebSocketTicket,
  verifyAndConsumeWebSocketTicket,
} from '@velajs/vela/websocket';

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

const nonceStore = new MemoryNonceStore();

@WebSocketGateway({
  path: '/tenants/:tenantId/rooms/:room/ws',
  roomParam: 'room',
  authenticateUpgrade: async (_request, { ticket, gatewayPath, room }) => {
    if (!ticket) return false;
    return verifyAndConsumeWebSocketTicket(ticket, {
      secret: env.SOCKET_TICKET_SECRET,
      gatewayPath,
      room,
      nonceStore,
    });
  },
})
class RoomGateway {}
```

The HMAC claim has fixed `vela:websocket` / `socket-ticket`
audience-and-purpose tags and is bound to the declared gateway path, resolved
room, canonical principal, tenant, issue time, expiry, and generated nonce.
Lifetimes cannot exceed 30 seconds. Parsing is size-bounded and rejects unknown
fields; malformed, tampered, mismatched, future, expired, or replayed tokens
return `false`.

`MemoryNonceStore` is suitable only for a single process/isolate. Strong
single-use behavior across Cloudflare isolates requires a structural
`NonceStore` backed by a Durable Object (or another store whose `claim` operation
is atomic). The Node and Cloudflare transports persist the returned principal,
tenant, and `expiresAtMs` in connection state, then continue checking expiry and
authorization for frames and server-initiated delivery.

---

## Runtime setup

The gateway + module is identical; only the transport wiring differs.

### Cloudflare Workers (Durable Objects, hibernation)

```ts
// app.module.ts
import { Module } from '@velajs/vela';
import { CloudflareWebSocketModule } from '@velajs/cloudflare';
import { ChatGateway } from './chat.gateway.js';

@Module({
  imports: [CloudflareWebSocketModule.forRoot()],
  providers: [ChatGateway],
})
export class AppModule {}
```

```ts
// env.ts — use Wrangler's generated binding types in your application.
import { InjectionToken } from '@velajs/vela';
import type { ChatRoom } from './index.js';

export interface Env {
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
}
export const ENV = new InjectionToken<Env>('worker environment');
```

```ts
// Worker entry (src/index.ts)
import { createCloudflareWorker } from '@velajs/cloudflare';
import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';
import { AppModule } from './app.module.js';
import { ENV } from './env.js';

// The DO class name must match wrangler `class_name`.
export class ChatRoom extends VelaWebSocketDurableObject(AppModule, { envToken: ENV }) {}

export default createCloudflareWorker(AppModule, { envToken: ENV });
```

```toml
# wrangler.toml
main = "src/index.ts"
compatibility_date = "2024-11-06"
compatibility_flags = ["nodejs_compat"]   # REQUIRED — vela uses hono/context-storage (node:async_hooks)

[[durable_objects.bindings]]
name = "CHAT_ROOM"
class_name = "ChatRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatRoom"]
```

How it works: the Worker's Hono app validates the `Upgrade` header and forwards the request to the gateway + room Durable Object (a canonical namespace derived from the declared gateway path and room id). The DO owns the raw socket via `WebSocketPair` + `ctx.acceptWebSocket(server, tags)` (hibernatable) and dispatches `webSocketMessage`/`webSocketClose`/`webSocketError` into the gateway. **One Durable Object per gateway room = native horizontal scale without cross-gateway room collisions.** Hono's `upgradeWebSocket` cannot bridge DO hibernation, which is why the DO uses the raw runtime API.

Server-initiated push from an HTTP controller / cron / queue:

```ts
import { broadcastToRoom } from '@velajs/cloudflare';
// env is the native Worker environment, injected with @Inject(ENV).
await broadcastToRoom(env.CHAT_ROOM, '/rooms/:id/ws', roomId, 'order.created', order);
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

Delivery guarantees (honest): at-most-once, no ordering across publishers, no replay. The driver delivers locally first, then fans the command out on one broadcast channel; each instance filters to its own local room members and drops its own echo.

---

## Caveats & non-goals (v1)

- **`nodejs_compat` is required on Cloudflare** — vela statically imports `hono/context-storage` (`node:async_hooks`).
- Cloudflare per-connection state (`client.data`, room membership) lives in the hibernation **attachment** — max **16 KiB**; store larger state in Durable Object storage keyed by `client.id`. Room membership survives hibernation; never keep it in DO instance fields.
- Inbound and outbound frames default to a **64 KiB** limit. The per-gateway value follows each connection through local or Redis fan-out and Cloudflare hibernation. Raise `maxFrameBytes` only after considering isolate memory, synchronization traffic, and validation cost.
- Protocol is **JSON text frames only** — binary frames and backpressure signalling are out of scope.
- Not yet implemented: Worker-isolate `@WebSocketServer()` emit (use `broadcastToRoom` from a controller instead), cross-DO global `server.emit()`, per-user-DO direct messages.

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
