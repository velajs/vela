# Vela client SDK

Workspace for the Vela live-query client packages:

- **`@velajs/client`** (`packages/client`) — the framework-neutral core: live subscriptions over WebSocket (`$live` frames per [`@velajs/live-protocol`](https://github.com/velajs/live-protocol)), keyed delta merging, rebaseable cursor-gated optimistic updates, reconnect with cursor resume, presence preset (`@velajs/client/presence`). Zero runtime deps beyond the protocol package; `WebSocket`/`fetch` are injectable (SSR/edge safe).
- **`@velajs/react`** (`packages/react`) — React hooks (`useLiveQuery`, `useLiveMutation`, `usePresence`, `useConnectionStatus`, `useClientQuery`, `usePendingMutations`) on `useSyncExternalStore`.

```ts
import { LiveClient } from '@velajs/client';

interface AppLive {
  'todos.list': { args: { listId: string }; result: Todo[] };
}

const client = new LiveClient<AppLive>({ url: 'https://api.example.com' });
const stop = client.subscribe('todos.list', { listId: 'l1' }, (todos) => render(todos));

await client.mutate('/todos', { text: 'ship it' }, {
  optimistic: {
    query: 'todos.list',
    args: { listId: 'l1' },
    apply: (todos = []) => [...todos, { id: 'temp', text: 'ship it' }],
  },
});
```

The optimistic layer above survives unrelated live updates (it re-folds onto each new server value) and is dropped exactly when a subscription frame's cursor passes the mutation's `Vela-Commit-Cursor` response header — never on HTTP timing, which races the broadcast.

## Pluggable seams (BYO storage / fetch / socket)

The client factory takes three structural seams — zero new runtime deps, all optional:

- `WebSocket?: (url) => WebSocketLike` — the live socket factory (defaults to `globalThis.WebSocket`).
- `fetch?: typeof fetch` — the mutation transport (defaults to `globalThis.fetch`).
- `mutationStore?: MutationStore` — the durable offline-queue backing store (see below).

Together these are exactly what a future `@velajs/react-native` plugs (an `AsyncStorage`-backed `MutationStore`, a credentialed `fetch`, an RN `WebSocket` wrapper) with no core change.

## Offline mutation queue (`@velajs/client/offline`)

Opt in with `offline`. Writes issued while proven offline are painted optimistically, persisted (if a `mutationStore` is given), and replayed **FIFO, at-least-once** on reconnect — a record is dropped from the store only after the server settles it.

```ts
import { LiveClient } from '@velajs/client';
import { createMemoryMutationStore, createSnapshotPrecondition } from '@velajs/client/offline';

const client = new LiveClient<AppLive>({
  url: 'https://api.example.com',
  offline: { maxItems: 1000, queueBeforeFirstConnect: true },
  mutationStore: createMemoryMutationStore(), // swap for an IndexedDB / AsyncStorage store
  persistenceVersion: 'v3', // stale-version records are purged on reload
  identity: () => currentUserId(), // replay is identity-gated across a reload
});

await client.mutate('/todos/t1', { done: true }, {
  // OCC: drop this queued write if the value it assumed changed while offline.
  precondition: createSnapshotPrecondition(client, 'todos.list', { listId }),
});

client.pendingMutations(); // → number waiting
client.onMutationSettled((e) => report(e)); // committed | rejected | dropped, incl. hydrated writes
await client.flush(); // force a replay (e.g. from a `navigator.onLine` handler)
```

Guards on replay: a failing `precondition` drops with `OFFLINE_PRECONDITION_FAILED`; a stale `persistenceVersion` or mismatched `identity` drops on hydrate/replay; an un-encodable body rejects terminally (never loops); a transport error requeues the write in order and retries on the next flush. `onMutationSettled` is the only channel for a hydrated (post-reload, awaiter-less) write's outcome — `hadAwaiter` distinguishes it from a live `mutate()` promise.

## Cross-tab coordination

Opt in with `crossTab`. One tab is elected **leader** (BroadcastChannel, `tabId` tie-break) and owns the live sockets; every other tab is a **follower** that forwards its subscription intent and renders the leader's relayed snapshots — so N tabs share **one** connection instead of N. The leader relays each subscription's `serverBase` + cursor/epoch, so follower optimistic updates stay cursor-gated identically to the leader's. On leader death a follower promotes and resubscribes from the last relayed cursor (the server resumes, no cold re-run). Where `BroadcastChannel` is unavailable (SSR, Node, React Native) the coordinator is a no-op and the tab is sole leader, so subscriptions never silently break.

```ts
const client = new LiveClient<AppLive>({ url, crossTab: true });
client.isLeader(); // true when this tab owns the sockets (always true when crossTab is off)
```

> Cross-tab uses BroadcastChannel. A service-worker relay (for browsers where BroadcastChannel is unavailable but service workers are) is a future additive `@velajs/client/sw` subpath — it needs a separately compiled worker script served as a static file plus framework-specific registration, so it does not land as a small additive adapter here. The no-op-without-BroadcastChannel fallback keeps those environments correct (sole-leader) meanwhile.

## Client queries (local-only reactive state)

A tiny local KV with the same `useSyncExternalStore` mechanics as a live query but no wire traffic — for filters, drafts, view toggles.

```ts
import { createClientQuery } from '@velajs/client';
const filter = createClientQuery<'all' | 'active'>('todos.filter', 'all');
// React: const [value, setValue] = useClientQuery(filter);
```

## Local development

Cross-repo deps resolve from npm. To develop against local checkouts before a release train, add temporary overrides to the workspace root `package.json` (do not commit them):

```jsonc
"pnpm": { "overrides": {
  "@velajs/live-protocol": "link:../live-protocol",
  "@velajs/vela": "link:../vela"
} }
```

`pnpm test` runs unit + protocol-conformance suites and an in-memory e2e against the real `@velajs/vela/live` engine.
