# Live queries

Share one named query definition between server and browser. The wire format is `@velajs/live-protocol` version 2 under the reserved `$live` WebSocket event; do not maintain a separate result-only interface or a local codec copy.

```ts
// shared/live.ts — portable, imported by server and browser
import { defineLiveQuery } from '@velajs/live-protocol';
import { z } from 'zod';

export const todoList = defineLiveQuery({
  name: 'todos.list', // the wire name, declared once (1-256 characters)
  args: z.object({ listId: z.string() }),
  result: z.array(z.object({ id: z.string(), text: z.string() })),
});
export const queries = [todoList];
```

## Server

```ts nocheck
import { LiveModule, LiveQuery, LiveResolver, type LiveQueryContext } from '@velajs/vela/live';

@LiveResolver() // implies @Injectable()
class TodoLive {
  constructor(private readonly todos: TodoService) {}

  @LiveQuery(todoList, { tags: (args) => [`todos:${args.listId}`] })
  list(args: ReturnType<typeof todoList.args.parse>, ctx: LiveQueryContext) {
    return this.todos.byList(args.listId, ctx.identity);
  }
}

@Module({ imports: [WebSocketModule.forRoot(), LiveModule.forRoot()], providers: [TodoLive, TodoService, RoomsGateway] })
class AppModule {}
```

`LiveModule` requires a WebSocket module in the same application; bootstrap fails without a `WsDispatcher`. The definition carries the name, checks method inputs/results, and parses arguments and final output at runtime, so a handler returns its rows without calling `.parse` itself. Duplicate names fail bootstrap. For CRUD tables, tag with `crudLiveTag('todos')` from `@velajs/crud`. Register the resolver as a provider. Handlers receive `(args, context)` positionally. Core/gateway/resolver authorization and identity expiry are rechecked on delivery and resume; invalid identities lose their subscriptions. Restored hibernation arguments are parsed again through the same schema.

Mark mutation handlers with `@LiveInvalidates(tags, { room? })`: after the handler succeeds it invalidates the tags (a string array, or `(result, context) => tags`; `[]` skips) and stamps `Vela-Commit-Cursor`/`Vela-Commit-Epoch` on the response through `switchToHttp().getResponse()` — never take `@Res()` to stamp. A throwing handler invalidates nothing; the declaring module must reach `LiveModule` (checked before the handler runs). An invalidation that fails after the handler succeeded (throwing tags/room callback, unreachable room) is reported through the error reporter (`edge: 'live'`) and the request still returns the handler's result without commit headers, so a client never retries a committed write because of it; keep writes idempotent (or take an idempotency key) for retries of lost responses. Elsewhere inject `LiveInvalidation` to call `invalidate({ tags, room? })`, which returns the log's `{ cursor, epoch }`. CRUD `live: true` bridges successful writes to `crud:<tableName>` tags and commit headers. `LiveInspector.inspect(rooms)` reads named rooms for admin surfaces (Studio's `livePanel({ rooms })`).

## Client and React

```ts
import { createLiveClient } from '@velajs/client';
import { queries } from './shared/live.js';

const client = createLiveClient({ url: 'https://api.example.com', queries });
client.subscribe('todos.list', { listId: 'one' }, (todos) => render(todos));
```

Query names, args, and results infer from the definitions (`queries: [todoList, ...]`; duplicate names throw `LIVE_SCHEMA_DUPLICATE`). Incoming snapshots, merged deltas, hydration, and cross-tab data are validated before committing state; invalid data preserves the last valid value/cursor. `subscribeRaw` and `peekRaw` expose dynamic tool queries as unknown. Mutations return unknown unless `parseResult` validates their response.

```ts
import { createLiveHooks } from '@velajs/react';
import type { InferLiveContract } from '@velajs/client';

export const { LiveProvider, useLiveQuery, useLiveMutation } =
  createLiveHooks<InferLiveContract<typeof queries>>();
```

Create that factory once at module scope; use its matching provider and hooks together. Optimistic layers rebase onto incoming state and retire at the mutation's commit cursor. Offline queues and cross-tab coordination require explicit authenticated account/session partitions; follow the client README for persistence and logout behavior.

## Transports and limits

- Local drivers/logs resume within one process lifetime; restart falls back to a snapshot.
- Redis fanout does not provide a shared log, so cross-instance resume falls back to snapshots.
- A runtime adapter's global `LIVE_PLATFORM` supplies the driver and cursor log the options leave open (`options.driver?.() ?? platform.liveDriver() ?? localLive()`). On Cloudflare that is `durableObjectLive()` in the Worker (the single binding-backed gateway's room Durable Object, namespace read from `ENV` lazily; an ambiguity error only when several could hold the subscriptions) and local delivery with a SQLite `DoCursorLog` inside the Durable Object; see `cloudflare.md`. Construct any configured `driver`/`log` with factories per application.
- One room per subscription. Query work is per subscription unless `coalesceBy` declares an equivalent authorization/result partition, which Vela scopes to the subscribing gateway's path, query and canonical args (two gateways never share a run); authorization and result baselines remain per subscriber.
- Presence uses `$presence.roster`, heartbeat TTLs, and immediate departure on close; each roster belongs to one gateway room (gateway path + room id); disable with `presence: false`.

For protocol guarantees, delivery/coalescing limits, and commit semantics consult the repository's `docs/live-queries.md`, protocol package README, and client README. HTTP RPC is separate: `@velajs/client/http` re-exports Hono `hc`; see `openapi.md`.
