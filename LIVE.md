# Live Queries (`@velajs/vela/live`)

Tag-based realtime reactivity: declare a query's dependency **tags**, and every write that invalidates a tag re-runs the affected subscriptions and pushes the result to their WebSocket clients — as an incremental keyed delta when possible. Inspired by lunora/Convex's "queries are live by default", adapted honestly to Vela's bring-your-own-database model: since the framework does not own your data layer, dependencies are declared (or derived from CRUD writes) rather than inferred from reads.

The wire contract lives in **`@velajs/live-protocol`** (frames, the shared delta codec, golden conformance fixtures); the browser side lives in **`@velajs/client`** (+ `@velajs/react`).

## Quickstart

```ts
// server — resolvers are ordinary providers
import { LiveModule, LiveQuery, LiveResolver } from '@velajs/vela/live';
import type { LiveQueryContext } from '@velajs/vela/live';

@LiveResolver()
@Injectable()
class TodoLive {
  constructor(private readonly todos: TodoService) {}

  @LiveQuery('todos.list', {
    tags: (args: { listId: string }) => [`crud:todos`, `todos:${args.listId}`],
    parse: (args) => TodoListArgs.parse(args), // zod slots straight in; validated ONCE at subscribe
  })
  list(args: { listId: string }, ctx: LiveQueryContext) {
    return this.todos.byList(args.listId, ctx.identity?.userId as string);
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
const client = new LiveClient<AppLive>({ url: 'https://api.example.com' });
client.subscribe('todos.list', { listId }, (todos) => render(todos));

await client.mutate('/todos', { text: 'ship it' }, {
  optimistic: { query: 'todos.list', args: { listId }, apply: (t = []) => [...t, temp] },
});
```

Writes invalidate tags either **automatically** — `@Crud({ ..., live: true })` in `@velajs/crud` emits `crud:<tableName>` after every successful write verb and stamps the commit headers — or **explicitly**:

```ts
const stamp = await this.live.invalidate({ tags: [`todos:${listId}`] }); // inject LiveInvalidation
```

## How it works

- Live frames ride the normal WebSocket envelope under the reserved `$live` event (the `$` prefix is framework-reserved; gateways cannot subscribe to it). One socket serves classic gateway events AND live frames.
- Subscribing runs app-wide guards (dispatcher tier) plus the resolver's own `@UseGuards` once; args are validated once; the subscriber's **identity** (from `client.data`, i.e. whatever your upgrade/`handleConnection` auth stamped) is captured and replayed into every re-run — including `identity.expiresAt` enforcement on the *outbound* path, since a passive subscriber never sends inbound frames.
- On invalidation the engine coalesces bursts, re-runs affected queries (bounded concurrency), and pushes: `settled` when the result is byte-identical (the cursor still advances — that is what drops optimistic layers), a batched keyed `delta` when the shared codec can diff, else a full `data` snapshot. Baselines advance only when a frame actually left the socket (at-least-once; deltas are idempotent).
- Every frame carries a **cursor + epoch** identifying a position in the *log scope*'s ordered invalidation log. Reconnecting clients resubscribe with their last watermark; untouched subscriptions get a tiny `resume` instead of a re-run.

## Cursors, resume, and transports

| Transport | Log scope | Epoch | Resume |
|---|---|---|---|
| node/bun/deno (default `localLive()`) | the process | per boot | in-memory ring (within process lifetime); restart ⇒ snapshot |
| `redisLive()` (`@velajs/vela/websocket-node`) | each instance | per boot | always snapshot across instances (fan-out bus, no shared log) |
| Cloudflare DO (`@velajs/cloudflare`) | one Durable Object ≈ one room | persisted in DO SQLite | **real** — survives hibernation and eviction |

### Cloudflare setup

```ts
LiveModule.forRoot({
  log: durableObjectCursorLog(),                 // SQLite-backed cursor log (per room DO)
  driver: durableObjectLive({ binding: 'CHAT_ROOM', defaultRoom: 'lobby' }),
})
```

- The DO class **must** be SQLite-backed: add it to wrangler `migrations[].new_sqlite_classes`.
- Worker-side `invalidate()` (HTTP mutations, crons, queue consumers) routes to the room DO's `invalidate` RPC and returns *that* log scope's stamp; inside the DO it applies locally. `liveInvalidateToRoom(ns, room, tags)` is the imperative sibling of `broadcastToRoom`.
- Subscriptions are persisted in the hibernation attachment and replayed on wake — an eviction is invisible to subscribers (their next update arrives as a snapshot, since the diff baseline is deliberately not persisted).

## Optimistic updates

Mutation responses expose `Vela-Commit-Cursor` / `Vela-Commit-Epoch` (automatic with the CRUD bridge, or via `stampCommitHeaders(c, stamp)`; with `VelaFactory.create(m, { ambientContainer: true })` `LiveInvalidation.invalidate()` stamps them itself). The client paints optimistic layers immediately, **re-folds them onto every new server value** (unrelated updates don't clobber them), and drops a layer only when a subscription frame's cursor passes the mutation's commit cursor — never on HTTP response timing, which races the broadcast. No headers ⇒ graceful one-shot optimism; failures roll back.

## Presence

The module ships a preset: `{ t: 'presence' }` heartbeat frames update a per-room roster; `$presence.roster` is a built-in live query; socket close departs immediately (TTL only covers ungraceful drops, filtered at read time — no timers). Client side: `createPresence(client, { room, meta })` or React's `usePresence(room, { meta })`. Disable with `LiveModule.forRoot({ presence: false })`.

## Cloudflare gotchas

- **Data locality**: the Worker and each Durable Object bootstrap SEPARATE app instances of the same module. State that live queries read and mutations write must live in a shared store (D1/KV/external DB) — per-isolate memory makes writes invisible to re-runs. See `examples/live-todo`'s `TodoStore` seam.
- **Commit headers on Workers**: stamp them explicitly (`stampCommitHeaders(c, stamp)`; the CRUD bridge does it automatically). Do NOT rely on `ambientContainer`: awaiting a Durable Object RPC inside hono's ALS `contextStorage()` middleware hangs the response under workerd.
- Driver/log option objects are shared between those app instances by construction; vela wraps the driver per app (`perAppLiveDriver`) so per-app sink/local-mode state never leaks across instances — custom drivers should keep instance state to isolate-wide concerns only.

## Guarantees & limits (v1)

- At-least-once frames; per-subscription total order within a log scope; coalescing may collapse bursts but every committed invalidation is observed by a re-run that starts after it.
- Tag granularity: N identical subscriptions re-run N times per invalidation. A row-level memoized reactive cache (lunora's `reactive-cache`/`dependency-tracker` design) is the planned optimization.
- A subscription lives in exactly one room; cross-room live queries are out of scope.
- Mid-subscription auth revocation is only enforced via `identity.expiresAt`; full re-authorization on re-run is out of scope.
- A typed client generated from OpenAPI operationIds + live metadata (`vela codegen`) is a planned CLI addition; v1 uses a hand-written `LiveContract` interface shaped to be codegen-compatible.

## Design notes

- The wire protocol is normative in `@velajs/live-protocol` (`LIVE_PROTOCOL = 1`); both sides run the same golden fixtures, so codec drift fails a test. Any wire change bumps the constant and releases in lockstep: live-protocol → vela → cloudflare → client.
- lunora's zero-dependency error-catalog design (one error class + central code catalog + a single wire-redaction seam, renderer split out for tree-shaking) is the recommended shape for Vela's planned exception-handler layer — noted here so the roadmap item starts from it.
