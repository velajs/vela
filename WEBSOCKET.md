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
- Application-level keepalive: send `{"event":"ping"}` → the server replies `{"event":"pong"}` (on Cloudflare this is answered *without waking* a hibernated Durable Object).

Client side is just the browser `WebSocket`:

```js
const ws = new WebSocket('wss://example.com/rooms/general/ws');
ws.onmessage = (e) => { const { event, data } = JSON.parse(e.data); /* ... */ };
ws.onopen = () => ws.send(JSON.stringify({ event: 'chat', data: { text: 'hi' } }));
```

---

## Quick start — the gateway (same on every runtime)

```ts
import {
  WebSocketGateway, SubscribeMessage, MessageBody, ConnectedSocket, WebSocketServer,
} from '@velajs/vela/websocket';
import type { WsClient, WsServer, OnGatewayConnection, OnGatewayDisconnect } from '@velajs/vela/websocket';

@WebSocketGateway({ path: '/rooms/:id/ws', binding: 'CHAT_ROOM' })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  // Constructor injection only (the DI container has no property-injection pass).
  constructor(@WebSocketServer() private readonly server: WsServer) {}

  handleConnection(client: WsClient) {
    this.server.emit('system', { text: `${client.id.slice(0, 8)} joined` });
  }
  handleDisconnect(client: WsClient) {
    this.server.emit('system', { text: `${client.id.slice(0, 8)} left` });
  }

  @SubscribeMessage('chat')
  onChat(@MessageBody() body: { text: string }, @ConnectedSocket() client: WsClient) {
    this.server.to([...client.rooms][0]).emit('chat', { from: client.id.slice(0, 8), text: body.text });
    return { event: 'ack', data: { ok: true } }; // WsResponse → replies to the sender
  }
}
```

`@WebSocketGateway(options)`:
- `path` — the route the upgrade is served on (supports params, e.g. `:id`).
- `binding` — **Cloudflare only**: the `wrangler.toml` Durable Object binding name that hosts this gateway's sockets. Ignored on node/bun/deno.

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
@Injectable()
class WsAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'ws') return true;
    const client = ctx.switchToWs().getClient<WsClient>();
    return Boolean(client.data.userId);
  }
}

@SubscribeMessage('secret')
@UseGuards(WsAuthGuard)          // deny → { event: 'exception', data: { message: 'Forbidden' } }
onSecret() { /* ... */ }
```

- `ExecutionContext.getType()` is now `'http' | 'ws'`. On a WS context, `switchToHttp()` / `getRequest()` / `getContext()` **throw** (there is no HTTP request) — rewrite HTTP-request-reading guards to use `switchToWs().getClient()`.
- **Global components apply to gateways.** `APP_GUARD` / `APP_PIPE` / `APP_INTERCEPTOR` / `APP_FILTER` providers (and `app.useGlobalGuards()` etc.) run on WS messages, exactly as on HTTP routes — so an app-wide auth guard protects both transports.
- Throw `WsException(stringOrObject)` from a guard/handler to send a client-facing error frame. Register a `@Catch(WsException)` `ExceptionFilter` to customize it.
- **Note:** request-scoped (`Scope.REQUEST`) providers that depend on the HTTP request are not available in gateways.

---

## Runtime setup

The gateway + module is identical; only the transport wiring differs.

### Cloudflare Workers (Durable Objects, hibernation)

```ts
// app.module.ts
import { CloudflareWebSocketModule } from '@velajs/cloudflare';
import { DurableObjectModule } from '@velajs/cloudflare';

@Module({
  imports: [
    CloudflareWebSocketModule.forRoot(),
    DurableObjectModule.forRoot({ binding: 'CHAT_ROOM' }), // for server-initiated emits from controllers
  ],
  providers: [ChatGateway],
})
export class AppModule {}
```

```ts
// worker entry (src/index.ts)
import { createCloudflareApp, VelaWebSocketDurableObject } from '@velajs/cloudflare';
import { AppModule } from './app.module';

// The DO class name must match wrangler `class_name`.
export class ChatRoom extends VelaWebSocketDurableObject(AppModule) {}

let appPromise: ReturnType<typeof createCloudflareApp> | undefined;
export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    appPromise ??= createCloudflareApp(AppModule);
    return (await appPromise).fetch(request, env, ctx);
  },
};
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

How it works: the Worker's Hono app validates the `Upgrade` header and forwards the request to the room's Durable Object (addressed by `idFromName(roomId)`). The DO owns the raw socket via `WebSocketPair` + `ctx.acceptWebSocket(server, tags)` (hibernatable) and dispatches `webSocketMessage`/`webSocketClose`/`webSocketError` into the gateway. **One Durable Object per room = native horizontal scale.** Hono's `upgradeWebSocket` cannot bridge DO hibernation, which is why the DO uses the raw runtime API.

Server-initiated push from an HTTP controller / cron / queue:

```ts
import { broadcastToRoom } from '@velajs/cloudflare';
// ns = DurableObjectService.namespace
await broadcastToRoom(ns, `org:${orgId}`, 'order.created', order);
```

### Node.js

```ts
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws'; // or @hono/node-server v2 built-in upgradeWebSocket
import { VelaFactory } from '@velajs/vela';
import { WebSocketModule } from '@velajs/vela/websocket';
import { registerWebSocketGateways } from '@velajs/vela/websocket-node';

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

On node/bun/deno each connection auto-joins the room from the `:id` route param (or the route path), mirroring the Cloudflare DO-per-room model.

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
- Protocol is **JSON text frames only** — binary frames and backpressure signalling are out of scope.
- Not yet implemented: Worker-isolate `@WebSocketServer()` emit (use `broadcastToRoom` from a controller instead), cross-DO global `server.emit()`, per-user-DO direct messages.
