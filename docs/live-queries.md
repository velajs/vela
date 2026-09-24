# Live Queries (`@velajs/vela/live`)

Tag-based realtime reactivity: declare a query's dependency **tags**, and every write that invalidates a tag re-runs the affected subscriptions and pushes the result to their WebSocket clients — as an incremental keyed delta when possible. Inspired by lunora/Convex's "queries are live by default", adapted honestly to Vela's bring-your-own-database model: since the framework does not own your data layer, dependencies are declared (or derived from CRUD writes) rather than inferred from reads.

The wire contract lives in **`@velajs/live-protocol`** (frames, the shared delta codec, golden conformance fixtures); the browser side lives in **`@velajs/client`** (+ `@velajs/react`).

## Quickstart

```ts
// server — resolvers are ordinary providers
import { Module } from '@velajs/vela';
import { LiveModule, LiveQuery, LiveResolver, defineLiveQuery } from '@velajs/vela/live';
import type { LiveQueryContext } from '@velajs/vela/live';
import { WebSocketModule } from '@velajs/vela/websocket';
import { crudLiveTag } from '@velajs/crud';

// Put this definition in a portable module imported by both server and browser.
// It declares the query's wire name once.
const todoListDefinition = defineLiveQuery({
  name: 'todos.list',
  args: TodoListArgs,
  result: TodoListResult,
});

@LiveResolver() // implies @Injectable()
class TodoLive {
  constructor(private readonly todos: TodoService) {}

  @LiveQuery(todoListDefinition, {
    tags: (args) => [crudLiveTag('todos'), `todos:${args.listId}`],
  })
  list(args: { listId: string }, ctx: LiveQueryContext) {
    const userId = ctx.identity?.userId;
    if (typeof userId !== 'string') throw new Error('authenticated user required');
    return this.todos.byList(args.listId, userId);
  }
}

@Module({
  imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
  providers: [RoomsGateway, TodoLive, TodoService],
})
class AppModule {}
```

```ts
// browser — @velajs/client (or the @velajs/react hooks)
import { createLiveClient } from '@velajs/client';

const client = createLiveClient({
  url: 'https://api.example.com',
  queries: [todoListDefinition],
});
client.subscribe('todos.list', { listId }, (todos) => render(todos));

await client.mutate('/todos', { text: 'ship it' }, {
  optimistic: { query: 'todos.list', args: { listId }, apply: (t = []) => [...t, temp] },
});
```

Subscriptions arrive over the `$live` WebSocket event, so `LiveModule` requires
`WebSocketModule.forRoot()` in the same application, on every runtime. Without it,
bootstrap fails instead of silently dropping every subscription.

`crudLiveTag(table)` from `@velajs/crud` names the tag a live CRUD resource
invalidates (`crud:<table>`). The engine parses every result with the
definition's `result` schema after the resolver and its interceptors run, so a
resolver returns its rows as read; a result that fails the schema is reported
and never cached or delivered.

Writes invalidate tags either **automatically** — `@Crud({ ..., live: true })` in `@velajs/crud` emits `crud:<tableName>` after every successful write verb and stamps the commit headers — or **declaratively** on a handler:

```ts
@Post()
@LiveInvalidates((todo: Todo) => [`todos:${todo.listId}`])
create(@Body(CreateTodo) body: CreateTodo): Promise<Todo> {
  return this.todos.add(body);
}
```

`@LiveInvalidates(tags, { room? })` runs as an interceptor: after the handler
succeeds it invalidates the tags (static, or derived from the result and the
execution context), then stamps the commit headers on the handler's HTTP
response through `switchToHttp().getResponse()`, or on a `Response` the handler
returns. A handler that throws invalidates nothing, and a tags callback that
returns `[]` skips the invalidation. It resolves `LiveInvalidation` from the
module that declares the controller before the handler runs, so a module that
cannot reach `LiveModule` fails without committing the write. For code outside
a handler, inject `LiveInvalidation`:

```ts
const stamp = await this.live.invalidate({ tags: [`todos:${listId}`] }); // returns { cursor, epoch }
```

## How it works

- Live frames ride the normal WebSocket envelope under the reserved `$live` event (the `$` prefix is framework-reserved; gateways cannot subscribe to it). One socket serves classic gateway events AND live frames. The same dispatcher answers the reserved `$ping`/`$pong` liveness exchange on every transport; Cloudflare can auto-respond without waking a hibernated Durable Object, and clients enable the silence watchdog only after a peer proves support.
- Subscribing runs app-wide guards (dispatcher tier) plus the resolver's own `@UseGuards`; the shared definition parses args once and binds them to the handler, tags, and coalescing callbacks. A tags function receives `(args, context)`: `context.path` is the route path of the gateway the connection subscribed through, for tags that must not reach another gateway's rooms with the same id. Final results are parsed after interceptors, before caching or delta encoding. The subscriber's **identity** (from trusted `client.data`) is captured and replayed into every re-run. Before resume or invalidation delivery, app-wide/gateway delivery authorization, resolver guards, optional `authorizeDelivery`, and `identity.expiresAtMs` are rechecked. Revocation purges subscriptions and closes with 1008.
- On invalidation the engine coalesces bursts, re-runs affected queries (bounded concurrency), and pushes: `settled` when the result is byte-identical (the cursor still advances — that is what drops optimistic layers), otherwise the smaller of a valid batched keyed `delta` and a full `data` snapshot measured from their actual canonical UTF-8 WebSocket envelopes (ties use the snapshot). Baselines advance only when a frame actually left the socket (at-least-once; deltas are idempotent).
- Every frame carries a **cursor + epoch** identifying a position in the *log scope*'s ordered invalidation log. Reconnecting clients resubscribe with their last watermark; untouched subscriptions get a tiny `resume` instead of a re-run.

### High-fanout execution coalescing

Resolver runs remain per subscription by default. A side-effect-free query can opt into flush-local sharing with `coalesceBy`; Vela automatically combines the returned authorization/result partition with the query name and canonical parsed args:

```ts
@LiveQuery(todoListDefinition, {
  tags: (args) => [`todos:${args.listId}`],
  coalesceBy: (_args, { identity }) =>
    typeof identity?.tenantId === 'string' ? identity.tenantId : undefined,
})
list(args: { listId: string }, ctx: LiveQueryContext) {
  const tenantId = ctx.identity?.tenantId;
  if (typeof tenantId !== 'string') throw new Error('tenant required');
  return this.todos.byList(args.listId, tenantId);
}
```

Returning the same partition is an application assertion that the complete resolver/interceptor result is equivalent for those subscribers, including any state reachable through `identity`, `clientId`, rooms, or the interceptor execution context. Expiry, WebSocket delivery authorization, resolver guards, and `authorizeDelivery` still run per subscription before sharing; explicit BYO-DB tags still decide which subscriptions enter a pass; and each recipient still diffs against and advances its own baseline/cursor. The Promise cache exists for one drain pass only and is capped at 256 groups, 64 KiB per retained result, and 2 MiB of retained serialized results; overflow executes independently. `undefined`, a thrown callback, an empty/control-bearing partition, a partition over 256 UTF-8 bytes, exotic args, or canonical args over 4 KiB all fail closed to an independent run.

## Cursors, resume, and transports

| Transport | Log scope | Epoch | Resume |
|---|---|---|---|
| node/bun/deno (default `localLive()`) | the process | per boot | in-memory ring (within process lifetime); restart ⇒ snapshot |
| `redisLive()` (`@velajs/vela/websocket-node`) | each instance | per boot | always snapshot across instances (fan-out bus, no shared log) |
| Cloudflare DO (`@velajs/cloudflare`) | one Durable Object ≈ one room | persisted in DO SQLite | **real** — survives hibernation and eviction |

### Cloudflare setup

```ts
@Module({
  imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
  providers: [RoomsGateway, TodoQueries], // RoomsGateway: @WebSocketGateway({ binding: 'CHAT_ROOM', ... })
})
export class AppModule {}
```

The Cloudflare adapter supplies what the options leave open through the global
`LIVE_PLATFORM` token. In the Worker, the default driver is `durableObjectLive()`:
it sends each invalidation to the room Durable Object of the application's single
gateway that names a `binding`, reading that namespace from `ENV` when an
invalidation first needs it. Inside the Durable Object, delivery is local and the
cursor log lives in the object's SQLite storage (an in-memory log when the class is
not SQLite-backed). A gateway without `roomParam` keeps every socket in one room
Durable Object, named by its path, so every invalidation and inspection goes to
that object whatever room it names, as upgrades and `Gateways` pushes do. With
several binding-backed gateways, the first Worker invalidation fails with an
ambiguity error; name the gateway (or binding, and the room used when an
invalidation names none):

```ts
LiveModule.forRoot({
  driver: () => durableObjectLive({ gatewayPath: '/rooms/:id/ws', defaultRoom: 'lobby' }),
})
```

`driver` and `log` are factories, called once per application. Return fresh instances:
the same module definition can bootstrap a Worker and multiple Durable Objects, each
with its own environment, sink, cursor, and epoch. Factories may be asynchronous.
`createCloudflareWorker` and `VelaWebSocketDurableObject` each seed their own
environment as `ENV`, and `wrangler types` types `env.CHAT_ROOM` from the Wrangler
file. A Worker configured with `localLive()` warns once: its invalidations would
never reach the subscriptions the Durable Object holds.

- Declare the DO class SQLite-backed (wrangler `migrations[].new_sqlite_classes`) so its cursor log survives hibernation and eviction. A class declared with `new_classes` keeps an in-memory log, so a client reconnecting after an eviction receives a snapshot.
- Worker-side `invalidate()` (HTTP mutations, crons, queue consumers) routes to the gateway + room DO's `invalidate` RPC and returns *that* log scope's stamp; inside the DO it applies locally. `liveInvalidateToRoom(ns, gatewayPath, room, tags)` does the same through an explicit namespace.
- Subscriptions persist their original args in the hibernation attachment. Restore validates record fields and data-only identity claims, reparses args through the query definition, and recomputes dependency tags. An eviction is invisible to subscribers; the next update is a snapshot because cached result/cursor baselines are never restored.

## Inspection

`LiveInspector` (exported by `LiveModule`) reads the subscriptions and presence
rooms of the rooms you name, for an authenticated admin surface: there is no
global room list. `inspect(rooms)` reads each room where its subscriptions
live. A platform adapter reads it through `LIVE_PLATFORM.inspect(room)`: on
Cloudflare the Worker calls the `inspectLive` RPC of the room's Durable Object,
through the gateway binding the live driver delivers to. A subscription's room
is each room its socket joined; the sockets of a gateway without `roomParam`
join its path, so name that path to inspect them. Each subscription and each
room member is reported once, even when several named rooms live in one object. Without a platform
reader, the application's own engine answers. Rows exclude query arguments,
results and identity claims. Studio's `StudioLiveModule.forRoot({ rooms })`
uses it.

## Optimistic updates

Mutation responses expose `Vela-Commit-Cursor` / `Vela-Commit-Epoch` (automatic with the CRUD bridge and `@LiveInvalidates`; with `VelaFactory.create(m, { ambientContainer: true })` `LiveInvalidation.invalidate()` stamps them itself, and `stampCommitHeaders(c, stamp)` writes them onto any Hono context). The client paints optimistic layers immediately, **re-folds them onto every new server value** (unrelated updates don't clobber them), and drops a layer only when a subscription frame's cursor passes the mutation's commit cursor — never on HTTP response timing, which races the broadcast. No headers ⇒ graceful one-shot optimism; failures roll back.

## Presence

The module ships a preset: `{ t: 'presence' }` heartbeat frames update the roster of one gateway room (the gateway's path and the room id, so gateways whose rooms share an id keep separate rosters); `$presence.roster` is a built-in live query; socket close departs immediately (TTL only covers ungraceful drops, filtered at read time — no timers). Client side: `createPresence(client, { room, meta })` or React's `usePresence(room, { meta })`. Disable with `LiveModule.forRoot({ presence: false })`.

Defaults are 100 subscriptions per socket, 100 tags per subscription or
invalidation, 10,000 refreshes per drain pass, and 4 KiB of presence metadata.
All may be lowered; the first three have explicit bounded module options.

## Cloudflare gotchas

- **Data locality**: the Worker and each Durable Object bootstrap SEPARATE app instances of the same module. State that live queries read and mutations write must live in a shared store (D1/KV/external DB) — per-isolate memory makes writes invisible to re-runs. See the [live todo example](../apps/live-todo/README.md).
- **Commit headers on Workers**: stamp them with `@LiveInvalidates` (the CRUD bridge does it automatically). Do NOT rely on `ambientContainer`: awaiting a Durable Object RPC inside hono's ALS `contextStorage()` middleware hangs the response under workerd.
- **Worker-side driver**: leave `driver` unset. `localLive()` would deliver to the engine in the Worker isolate, but the subscriptions live in the Durable Object, so the Cloudflare adapter warns once per isolate when a Worker application configures it.
- Driver/log factories run once in each application container. Keep state on the returned instance and return a new instance each time; shared mutable drivers or logs would leak environment bindings, sinks, or cursor state between applications.

## Guarantees & limits (v1)

- At-least-once frames; per-subscription total order within a log scope; coalescing may collapse bursts but every committed invalidation is observed by a re-run that starts after it.
- Tag granularity remains explicit. N identical subscriptions re-run N times unless their query opts into `coalesceBy`; one matching `(query, canonical args, partition)` then executes once per pass and fans out through N independent delivery baselines.
- A subscription lives in exactly one room; cross-room live queries are out of scope.
- Resume, invalidation re-runs, and delivery re-check identity expiry plus the
  app/gateway/resolver authorization chain. A revoked identity removes the
  subscription and closes the socket with 1008.
- Server and client import the same `defineLiveQuery({ name, args, result })` definitions, so each query's name is declared once. The typed decorator checks handler args/results; `createLiveClient({ queries: [definition, ...] })` infers its contract, keyed by name, from the definitions. No separately maintained live result interface is needed.

## Protocol compatibility

- The wire protocol is normative in `@velajs/live-protocol` (`LIVE_PROTOCOL = 2`); both sides run the same golden fixtures, so codec drift fails a test. Any wire change bumps the constant and releases in lockstep: live-protocol → vela → cloudflare → client.
