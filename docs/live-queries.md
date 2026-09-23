# Live Queries (`@velajs/vela/live`)

Tag-based realtime reactivity: declare a query's dependency **tags**, and every write that invalidates a tag re-runs the affected subscriptions and pushes the result to their WebSocket clients — as an incremental keyed delta when possible. Inspired by lunora/Convex's "queries are live by default", adapted honestly to Vela's bring-your-own-database model: since the framework does not own your data layer, dependencies are declared (or derived from CRUD writes) rather than inferred from reads.

The wire contract lives in **`@velajs/live-protocol`** (frames, the shared delta codec, golden conformance fixtures); the browser side lives in **`@velajs/client`** (+ `@velajs/react`).

## Quickstart

```ts
// server — resolvers are ordinary providers
import { LiveModule, LiveQuery, LiveResolver, defineLiveQuery } from '@velajs/vela/live';
import type { LiveQueryContext } from '@velajs/vela/live';

// Put this definition in a portable module imported by both server and browser.
const todoListDefinition = defineLiveQuery({ args: TodoListArgs, result: TodoListResult });

@LiveResolver()
@Injectable()
class TodoLive {
  constructor(private readonly todos: TodoService) {}

  @LiveQuery('todos.list', todoListDefinition, {
    tags: (args) => [`crud:todos`, `todos:${args.listId}`],
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
  queries: { 'todos.list': todoListDefinition },
});
client.subscribe('todos.list', { listId }, (todos) => render(todos));

await client.mutate('/todos', { text: 'ship it' }, {
  optimistic: { query: 'todos.list', args: { listId }, apply: (t = []) => [...t, temp] },
});
```

Subscriptions arrive over the `$live` WebSocket event, so `LiveModule` requires a
WebSocket module in the same application (`WebSocketModule.forRoot()`, or
`CloudflareWebSocketModule.forRoot()` on Cloudflare). Without one, bootstrap fails
instead of silently dropping every subscription.

Writes invalidate tags either **automatically** — `@Crud({ ..., live: true })` in `@velajs/crud` emits `crud:<tableName>` after every successful write verb and stamps the commit headers — or **explicitly**:

```ts
const stamp = await this.live.invalidate({ tags: [`todos:${listId}`] }); // inject LiveInvalidation
```

## How it works

- Live frames ride the normal WebSocket envelope under the reserved `$live` event (the `$` prefix is framework-reserved; gateways cannot subscribe to it). One socket serves classic gateway events AND live frames. The same dispatcher answers the reserved `$ping`/`$pong` liveness exchange on every transport; Cloudflare can auto-respond without waking a hibernated Durable Object, and clients enable the silence watchdog only after a peer proves support.
- Subscribing runs app-wide guards (dispatcher tier) plus the resolver's own `@UseGuards`; the shared definition parses args once and binds them to the handler, tags, and coalescing callbacks. Final results are parsed after interceptors, before caching or delta encoding. The subscriber's **identity** (from trusted `client.data`) is captured and replayed into every re-run. Before resume or invalidation delivery, app-wide/gateway delivery authorization, resolver guards, optional `authorizeDelivery`, and `identity.expiresAtMs` are rechecked. Revocation purges subscriptions and closes with 1008.
- On invalidation the engine coalesces bursts, re-runs affected queries (bounded concurrency), and pushes: `settled` when the result is byte-identical (the cursor still advances — that is what drops optimistic layers), otherwise the smaller of a valid batched keyed `delta` and a full `data` snapshot measured from their actual canonical UTF-8 WebSocket envelopes (ties use the snapshot). Baselines advance only when a frame actually left the socket (at-least-once; deltas are idempotent).
- Every frame carries a **cursor + epoch** identifying a position in the *log scope*'s ordered invalidation log. Reconnecting clients resubscribe with their last watermark; untouched subscriptions get a tiny `resume` instead of a re-run.

### High-fanout execution coalescing

Resolver runs remain per subscription by default. A side-effect-free query can opt into flush-local sharing with `coalesceBy`; Vela automatically combines the returned authorization/result partition with the query name and canonical parsed args:

```ts
@LiveQuery('todos.list', todoListDefinition, {
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
interface ChatEnv { CHAT_ROOM: DurableObjectNamespace<ChatRoom> }
const CHAT_ENV = new InjectionToken<ChatEnv>('chat environment');

LiveModule.forRootAsync({
  inject: [CHAT_ENV],                              // the envToken given to the Worker and DO
  useFactory: (env) => ({
    log: () => durableObjectCursorLog(),           // SQLite-backed cursor log (per room DO)
    driver: () => durableObjectLive({
      namespace: env.CHAT_ROOM,                    // the native namespace, not a binding name
      gatewayPath: '/rooms/:id/ws',
      defaultRoom: 'lobby',
    }),
  }),
})
```

`driver` and `log` are factories, called once per application. Return fresh instances:
the same module definition can bootstrap a Worker and multiple Durable Objects, each
with its own environment, sink, cursor, and epoch. Factories may be asynchronous.
`durableObjectLive` takes the room Durable Object's `namespace` object, so resolve the
environment with `LiveModule.forRootAsync` and return factories that capture it, as
above. Pass the same `envToken` to `createCloudflareWorker` and
`VelaWebSocketDurableObject`.

- The DO class **must** be SQLite-backed: add it to wrangler `migrations[].new_sqlite_classes`.
- Worker-side `invalidate()` (HTTP mutations, crons, queue consumers) routes to the gateway + room DO's `invalidate` RPC and returns *that* log scope's stamp; inside the DO it applies locally. `liveInvalidateToRoom(ns, gatewayPath, room, tags)` is the imperative sibling of `broadcastToRoom`.
- Subscriptions persist their original args in the hibernation attachment. Restore validates record fields and data-only identity claims, reparses args through the query definition, and recomputes dependency tags. An eviction is invisible to subscribers; the next update is a snapshot because cached result/cursor baselines are never restored.

## Optimistic updates

Mutation responses expose `Vela-Commit-Cursor` / `Vela-Commit-Epoch` (automatic with the CRUD bridge, or via `stampCommitHeaders(c, stamp)`; with `VelaFactory.create(m, { ambientContainer: true })` `LiveInvalidation.invalidate()` stamps them itself). The client paints optimistic layers immediately, **re-folds them onto every new server value** (unrelated updates don't clobber them), and drops a layer only when a subscription frame's cursor passes the mutation's commit cursor — never on HTTP response timing, which races the broadcast. No headers ⇒ graceful one-shot optimism; failures roll back.

## Presence

The module ships a preset: `{ t: 'presence' }` heartbeat frames update a per-room roster; `$presence.roster` is a built-in live query; socket close departs immediately (TTL only covers ungraceful drops, filtered at read time — no timers). Client side: `createPresence(client, { room, meta })` or React's `usePresence(room, { meta })`. Disable with `LiveModule.forRoot({ presence: false })`.

Defaults are 100 subscriptions per socket, 100 tags per subscription or
invalidation, 10,000 refreshes per drain pass, and 4 KiB of presence metadata.
All may be lowered; the first three have explicit bounded module options.

## Cloudflare gotchas

- **Data locality**: the Worker and each Durable Object bootstrap SEPARATE app instances of the same module. State that live queries read and mutations write must live in a shared store (D1/KV/external DB) — per-isolate memory makes writes invisible to re-runs. See the [live todo example](../apps/live-todo/README.md).
- **Commit headers on Workers**: stamp them explicitly (`stampCommitHeaders(c, stamp)`; the CRUD bridge does it automatically). Do NOT rely on `ambientContainer`: awaiting a Durable Object RPC inside hono's ALS `contextStorage()` middleware hangs the response under workerd.
- **Worker-side driver**: the default `localLive()` delivers to the engine in the same isolate, but the subscriptions live in the Durable Object. The Cloudflare adapter warns once per isolate when the Worker bootstraps `LiveModule` with `localLive()`; pass `driver: () => durableObjectLive({ namespace, gatewayPath })`.
- Driver/log factories run once in each application container. Keep state on the returned instance and return a new instance each time; shared mutable drivers or logs would leak environment bindings, sinks, or cursor state between applications.

## Guarantees & limits (v1)

- At-least-once frames; per-subscription total order within a log scope; coalescing may collapse bursts but every committed invalidation is observed by a re-run that starts after it.
- Tag granularity remains explicit. N identical subscriptions re-run N times unless their query opts into `coalesceBy`; one matching `(query, canonical args, partition)` then executes once per pass and fans out through N independent delivery baselines.
- A subscription lives in exactly one room; cross-room live queries are out of scope.
- Resume, invalidation re-runs, and delivery re-check identity expiry plus the
  app/gateway/resolver authorization chain. A revoked identity removes the
  subscription and closes the socket with 1008.
- Server and client import the same `defineLiveQuery({ args, result })` definitions. The typed decorator checks handler args/results; `createLiveClient({ queries })` infers its contract from the parser map. No separately maintained live result interface is needed.

## Protocol compatibility

- The wire protocol is normative in `@velajs/live-protocol` (`LIVE_PROTOCOL = 2`); both sides run the same golden fixtures, so codec drift fails a test. Any wire change bumps the constant and releases in lockstep: live-protocol → vela → cloudflare → client.
