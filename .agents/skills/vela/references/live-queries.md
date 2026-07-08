# Live queries (`@velajs/vela/live`)

Tag-based realtime reactivity: `@LiveQuery` methods declare dependency tags; invalidating a tag re-runs affected WebSocket subscriptions and pushes results (keyed deltas when possible). Wire contract: `@velajs/live-protocol` (`$live` reserved envelope event, `LIVE_PROTOCOL = 1`); browser: `@velajs/client` + `@velajs/react`. Full doc: `LIVE.md`.

## Server

```ts
import { LiveModule, LiveQuery, LiveResolver, LiveInvalidation } from '@velajs/vela/live';
import type { LiveQueryContext } from '@velajs/vela/live';

@LiveResolver()               // stack with @Injectable, like @Processor
@Injectable()
class TodoLive {
  @LiveQuery('todos.list', {
    tags: (a: { listId: string }) => ['crud:todos', `todos:${a.listId}`], // string[] or (args) => string[]
    key: 'id',                // delta key field (default 'id')
    parse: (a) => Args.parse(a), // validated ONCE at subscribe; throw -> bad_args error frame
  })
  list(args: { listId: string }, ctx: LiveQueryContext) { /* ctx.identity, ctx.clientId, ctx.rooms */ }
}

@Module({ imports: [WebSocketModule.forRoot(), LiveModule.forRoot()], providers: [TodoLive] })
class AppModule {}
```

- `LiveModule.forRoot({ driver?, log?, identity?, presence? })` — EAGER module (self-driving). `identity` defaults to a shallow copy of `client.data` (your WS auth's stamp); `identity.expiresAt` (epoch ms) is enforced outbound. `presence: false` drops the preset.
- Handlers receive `(args, ctx)` positionally — no param decorators. Resolver `@UseGuards` run once at subscribe; re-runs replay the captured identity, guard-free.
- Explicit invalidation: inject `LiveInvalidation`; `await live.invalidate({ tags, room? })` returns `{ cursor, epoch }`. Stamp mutation responses via `stampCommitHeaders(c, stamp)` (automatic with ambientContainer or the CRUD bridge).
- CRUD bridge (`@velajs/crud`): `@Crud({ ..., live: true })` — successful write verbs invalidate `crud:<tableName>` and stamp `Vela-Commit-Cursor`/`Vela-Commit-Epoch`. `live: { tags?, room? }` derives extras from the Hono context.
- Presence preset: `{ t:'presence' }` heartbeats + built-in `$presence.roster` query (`PRESENCE_ROSTER_QUERY`); immediate departure on close; TTL filtered at read (no timers).
- The `$` WS event prefix is reserved (`@ReservedWsEvent`); gateways registering `$…` events are rejected at bootstrap.

## Transports

| Where | Setup | Resume |
|---|---|---|
| node/bun/deno | default (`localLive()` + in-memory log) | within process lifetime; restart ⇒ snapshot |
| multi-node | `LiveModule.forRoot({ driver: redisLive({ pub, sub }) })` (`@velajs/vela/websocket-node`) | always snapshot across instances |
| Cloudflare | `LiveModule.forRoot({ log: durableObjectCursorLog(), driver: durableObjectLive({ binding }) })` (`@velajs/cloudflare`); DO class needs wrangler `new_sqlite_classes` | REAL — SQLite log survives hibernation/eviction; subs replay from attachments |

`liveInvalidateToRoom(ns, room, tags)` = imperative worker-side invalidation (sibling of `broadcastToRoom`).

## Client (`@velajs/client`, `@velajs/react`)

```ts
const client = new LiveClient<AppLive>({ url });        // AppLive: { [query]: { args; result } }
client.subscribe('todos.list', { listId }, cb);          // dedupes identical (query,args,room)
await client.mutate('/todos', body, { optimistic: { query, args, apply: (v) => next } });
// React: <LiveProvider client={...}> + useLiveQuery / useLiveMutation / usePresence / useConnectionStatus
```

Optimistic layers re-fold over unrelated updates and drop when a frame's cursor passes the mutation's `Vela-Commit-Cursor` (never on HTTP timing). Reconnects resubscribe with cursor+epoch → `resume` (untouched) / `data` (touched) / snapshot (epoch fork).

## Gotchas

- Every re-run of N identical subscriptions runs N times (tag granularity; row-level cache is future work).
- One room per subscription; `durableObjectLive` routes invalidations by `room` (`defaultRoom` fallback `'default'`).
- `redisLive`/`localLive` cursors are per-instance — cross-instance optimistic gating degrades to one-shot (headers from a different scope's epoch are dropped).
- Openness: `src/live/*` imports only the public barrel + `@velajs/live-protocol` + `hono/context-storage` (machine-verified, `live-openness.test.ts`).
