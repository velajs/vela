# Vela client SDK

Workspace for the Vela live-query client packages:

- **`@velajs/client`** (`packages/client`) — the framework-neutral core: live subscriptions over WebSocket (`$live` frames per [`@velajs/live-protocol`](https://github.com/velajs/live-protocol)), keyed delta merging, rebaseable cursor-gated optimistic updates, reconnect with cursor resume, presence preset (`@velajs/client/presence`). Zero runtime deps beyond the protocol package; `WebSocket`/`fetch` are injectable (SSR/edge safe).
- **`@velajs/react`** (`packages/react`, upcoming) — React hooks (`useLiveQuery`, `useLiveMutation`, `usePresence`, `useConnectionStatus`) on `useSyncExternalStore`.

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

## Local development

Cross-repo deps resolve from npm. To develop against local checkouts before a release train, add temporary overrides to the workspace root `package.json` (do not commit them):

```jsonc
"pnpm": { "overrides": {
  "@velajs/live-protocol": "link:../live-protocol",
  "@velajs/vela": "link:../vela"
} }
```

`pnpm test` runs unit + protocol-conformance suites and an in-memory e2e against the real `@velajs/vela/live` engine.
