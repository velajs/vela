# Vela client SDK

HTTP and live-query clients for Vela applications.

For an `hc` HTTP client with generated request/response types, see [Typed HTTP client](HTTP.md).

- **`@velajs/client`** (`packages/client`) — the framework-neutral core: live subscriptions over WebSocket (`$live` frames per [`@velajs/live-protocol`](https://github.com/velajs/vela/tree/main/packages/live-protocol)), keyed delta merging, rebaseable cursor-gated optimistic updates, reconnect with cursor resume, presence preset (`@velajs/client/presence`). The live entry imports only the protocol package; the optional `@velajs/client/http` entry uses Hono's client. `WebSocket`/`fetch` are injectable (SSR/edge safe).
- **`@velajs/react`** (`packages/react`) — React hooks (`useLiveQuery`, `useLiveMutation`, `usePresence`, `useConnectionStatus`, `useClientQuery`, `usePendingMutations`) on `useSyncExternalStore`.

```ts
// shared/live.ts — import the same definition in the server and frontend
import { defineLiveQuery } from '@velajs/live-protocol';
import { z } from 'zod';

export const todo = z.object({ id: z.string(), text: z.string() });
export const todoList = defineLiveQuery({
  args: z.object({ listId: z.string() }),
  result: z.array(todo),
});
export const queries = { 'todos.list': todoList };
```

```ts
import { createLiveClient } from '@velajs/client';
import { queries, todo } from './shared/live';

const client = createLiveClient({ url: 'https://api.example.com', queries });
const stop = client.subscribe('todos.list', { listId: 'l1' }, (todos) => render(todos));
```

Query names, arguments, and result types are inferred from the parser map. On the server, use `@LiveQuery('todos.list', todoList, { tags: ['todos'] })` with the same descriptor. The client validates arguments before subscription and validates snapshots, merged deltas, SSR hydration, and cross-tab results before committing them. Invalid data emits `LIVE_SCHEMA_INVALID` and preserves the last valid value and cursor. Parser-produced snapshots retain stable identities between updates for React. `subscribeRaw` and `peekRaw` expose dynamic queries as `unknown` for tooling.

Mutations return `unknown` unless a parser supplies their result type:

```ts
const created = await client.mutate('/todos', { text: 'ship it' }, {
  parseResult: (value) => todo.parse(value),
});
```

A failed result parser rejects the promise after the write commits; it never queues an already committed write for replay. Optimistic updates remain cursor-gated and rebase onto new server values.

## React

Create the provider and hooks once at module scope from the shared contract:

```ts
import { createLiveHooks } from '@velajs/react';
import type { InferLiveContract } from '@velajs/client';
import { queries } from './shared/live';

export const { LiveProvider, useLiveQuery, useLiveMutation } =
  createLiveHooks<InferLiveContract<typeof queries>>();
```

Wrap the tree with `<LiveProvider client={client}>`. `useLiveQuery('todos.list', { listId })` retains the result type. `useLiveMutation(path, { parseResult })` infers its result from that parser. Hooks and their provider must come from the same factory call; there is no global context with a caller-selected generic.

## Pluggable seams (BYO storage / fetch / socket)

The client factory takes three structural seams — zero new runtime deps, all optional:

- `WebSocket?: (url) => WebSocketLike` — the live socket factory (defaults to `globalThis.WebSocket`).
- `fetch?: typeof fetch` — the mutation transport (defaults to `globalThis.fetch`).
- `mutationStore?: MutationStore` — the durable offline-queue backing store (see below).

The [React Native integration](../../packages/react-native/README.md) supplies native storage, authentication, and connection adapters.

## Offline mutation queue (`@velajs/client/offline`)

Opt in with `offline`. Writes issued while proven offline are painted optimistically, persisted (if a `mutationStore` is given), and replayed **FIFO, at-least-once** on reconnect — a record is dropped from the store only after the server settles it.

Offline mode requires `identity`, a stable non-secret account **and login-epoch** fingerprint. Every `MutationStore` operation receives that authenticated partition, so records from another account/epoch are never loaded. Persisted writes accept only relative same-origin paths and never store authorization headers. Hydration validates record schema/depth/bytes and rewrites oversized queues to the configured cap.

```ts
import { createLiveClient } from '@velajs/client';
import { queries } from './shared/live';
import { createMemoryMutationStore, createSnapshotPrecondition } from '@velajs/client/offline';

const client = createLiveClient({
  queries,
  url: 'https://api.example.com',
  offline: { maxItems: 1000, queueBeforeFirstConnect: true },
  identity: () => `${currentSession?.user.id}:${currentSession?.loginEpoch}`,
  mutationStore: createMemoryMutationStore(), // swap for an IndexedDB / AsyncStorage store
  persistenceVersion: 'v3', // stale-version records are purged on reload
});

await client.mutate('/todos/t1', { done: true }, {
  // OCC: drop this queued write if the value it assumed changed while offline.
  precondition: createSnapshotPrecondition(client, 'todos.list', { listId }),
});

client.pendingMutations(); // → number waiting
client.onMutationSettled((e) => report(e)); // committed | rejected | dropped, incl. hydrated writes
await client.flush(); // force a replay (e.g. from a `navigator.onLine` handler)
```

On logout or account switch, first change/clear the identity provider and then retire the exact previous fingerprint through the client. This rejects its pending writes with `OFFLINE_IDENTITY_PURGED`, aborts a replay already in flight, and serializes the final partition clear behind earlier appends. The active identity cannot be purged accidentally.

```ts
const previousIdentity = `${currentSession.user.id}:${currentSession.loginEpoch}`;
currentSession = undefined; // identity() must stop returning the previous epoch first
await client.purgeOfflineMutations(previousIdentity);
```

`client.close()` rejects live awaiters but deliberately leaves durable records intact for reload recovery; it is not a logout operation. Never call a backing store's unscoped/global clear from authentication code.

Guards on replay: a failing `precondition` drops with `OFFLINE_PRECONDITION_FAILED`; a stale `persistenceVersion` or mismatched `identity` drops on hydrate/replay; an un-encodable body rejects terminally (never loops); a transport error requeues the write in order and retries on the next flush. `onMutationSettled` is the only channel for a hydrated (post-reload, awaiter-less) write's outcome — `hadAwaiter` distinguishes it from a live `mutate()` promise.

## Cross-tab coordination

Cross-tab coordination is disabled by default. Opt in with an explicit app, authenticated-session, and account-epoch namespace. One tab is elected **leader** and owns the live sockets; every message is schema/size validated and messages cannot cross login epochs.

```ts
const client = createLiveClient({
  queries,
  url,
  crossTab: { appId: 'dashboard', sessionId: session.fingerprint, accountEpoch: loginEpoch },
});
client.isLeader(); // true when this tab owns the sockets (always true when crossTab is off)
```

Cross-tab coordination uses BroadcastChannel. When it is unavailable, each client owns its own sockets; coordination is disabled.

## Client queries (local-only reactive state)

Each `createClientQuery` reference owns its typed value; labels do not merge independent references. Export and reuse the same reference to share state across consumers. Values remain isolated between client instances.

A tiny local KV with the same `useSyncExternalStore` mechanics as a live query but no wire traffic — for filters, drafts, view toggles.

```ts
import { createClientQuery } from '@velajs/client';
const filter = createClientQuery<'all' | 'active'>('todos.filter', 'all');
// React: const [value, setValue] = useClientQuery(filter);
```

## Local development

Run `pnpm build` from the workspace root to build packages in dependency order. HTTP imports use the workspace's aligned Hono version.

`pnpm test` runs unit + protocol-conformance suites and an in-memory e2e against the real `@velajs/vela/live` engine.
