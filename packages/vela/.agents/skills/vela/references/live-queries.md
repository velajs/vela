# Live queries

Share runtime query schemas between server and browser. The wire format is `@velajs/live-protocol` version 2 under the reserved `$live` WebSocket event; do not maintain a separate result-only interface or a local codec copy.

```ts
// shared/live.ts — portable, imported by server and browser
import { defineLiveQuery } from '@velajs/live-protocol';
import { z } from 'zod';

export const todoList = defineLiveQuery({
  args: z.object({ listId: z.string() }),
  result: z.array(z.object({ id: z.string(), text: z.string() })),
});
export const queries = { 'todos.list': todoList };
```

## Server

```ts
import { LiveModule, LiveQuery, LiveResolver, type LiveQueryContext } from '@velajs/vela/live';

@LiveResolver()
@Injectable()
class TodoLive {
  constructor(private readonly todos: TodoService) {}

  @LiveQuery('todos.list', todoList, { tags: (args) => [`todos:${args.listId}`] })
  list(args: ReturnType<typeof todoList.args.parse>, ctx: LiveQueryContext) {
    return this.todos.byList(args.listId, ctx.identity);
  }
}

@Module({ imports: [WebSocketModule.forRoot({}), LiveModule.forRoot({})], providers: [TodoLive, TodoService, RoomsGateway] })
class AppModule {}
```

The definition checks method inputs/results and parses arguments and final output at runtime. Register the resolver as a provider. Handlers receive `(args, context)` positionally. Core/gateway/resolver authorization and identity expiry are rechecked on delivery and resume; invalid identities lose their subscriptions. Restored hibernation arguments are parsed again through the same schema.

Inject `LiveInvalidation` to call `invalidate({ tags, room? })`; it returns the log's `{ cursor, epoch }`. Stamp mutation responses with `stampCommitHeaders(context, stamp)`. CRUD `live: true` bridges successful writes to `crud:<tableName>` tags and commit headers. Extra tags and room selectors can be configured explicitly.

## Client and React

```ts
import { createLiveClient } from '@velajs/client';
import { queries } from './shared/live.js';

const client = createLiveClient({ url: 'https://api.example.com', queries });
client.subscribe('todos.list', { listId: 'one' }, (todos) => render(todos));
```

Query names, args, and results infer from the parser map. Incoming snapshots, merged deltas, hydration, and cross-tab data are validated before committing state; invalid data preserves the last valid value/cursor. `subscribeRaw` and `peekRaw` expose dynamic tool queries as unknown. Mutations return unknown unless `parseResult` validates their response.

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
- Cloudflare DO logs persist in SQLite. Construct `driver`/`log` with factories per application and supply a typed native namespace to `durableObjectLive`; see `cloudflare.md`.
- One room per subscription. Query work is per subscription unless `coalesceBy` declares an equivalent authorization/result partition; authorization and result baselines remain per subscriber.
- Presence uses `$presence.roster`, heartbeat TTLs, and immediate departure on close; disable with `presence: false`.

For protocol guarantees, delivery/coalescing limits, and commit semantics consult the repository's `docs/live-queries.md`, protocol package README, and client README. HTTP RPC is separate: `@velajs/client/http` re-exports Hono `hc`; see `openapi.md`.
