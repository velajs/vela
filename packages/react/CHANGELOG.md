# @velajs/react

## 1.23.0

### Minor Changes

- fd11d20: A live query's wire name now lives in its shared definition, so each name is declared once: `defineLiveQuery({ name: 'todos.list', args, result })`. The name must be a non-empty string of at most 256 characters, the longest a `sub` frame carries; `defineLiveQuery` throws otherwise. `LiveQueryDefinition<Name, Args, Result>` carries it as its first type parameter (all three default, so a bare `LiveQueryDefinition` accepts any definition).
  
  The server declares `@LiveQuery(definition, { tags })`, for example `@LiveQuery(todoList, { tags: [crudLiveTag('todos')] })`. The engine already validates every result with the definition's `result` schema after the resolver and its interceptors, so a resolver returns its rows as read instead of calling `.parse` itself.
  
  Clients take the same definitions as a list: `createLiveClient({ url, queries: [todoList] })` and `createNativeClient({ queries: [todoList], ... })` infer the contract, keyed by each definition's name. Two definitions with one name throw `LIVE_SCHEMA_DUPLICATE`. `new LiveClient<Contract>({ queries })` takes an explicit contract and no longer infers one from its options; `LiveQueryDefinitions<Contract>` types its list. `@velajs/react` hooks keep their API and are typed from the same list: `createLiveHooks<InferLiveContract<typeof queries>>()`, where `queries` is the array passed to `createLiveClient`.
  
  Engine errors name the definition instead of the removed decorator form: bootstrap reports "two live query definitions are named 'todos.list'" with both resolver methods, and a subscription to an unknown query receives "no live query named '…' is registered".
  
  **Behavior change:** `@LiveQuery(name, definition, options)` is removed; use `@LiveQuery(definition, options)` with `name` in `defineLiveQuery`. `defineLiveQuery({ args, result })` without a `name` no longer type-checks and throws at runtime. The client's `queries` option takes an array of definitions instead of a name-keyed map: replace `queries: { 'todos.list': todoList }` with `queries: [todoList]`. `InferLiveContract` takes the definition list type (`InferLiveContract<typeof queries>`), so React and React Native apps that typed their hooks from a `{ 'todos.list': todoList }` map export `const queries = [todoList]` instead and pass that array to both the client and `InferLiveContract`. The `LiveQuerySchemas` and `LiveQueryParsers` types are removed; use `LiveQueryDefinitions<Contract>` and `LiveQueryDefinition<Name, Args, Result>`. `LiveQueryDefinition<Args, Result>` became `LiveQueryDefinition<Name, Args, Result>`, so a two-argument annotation such as `LiveQueryDefinition<{ id: string }, Todo[]>` no longer compiles (its first argument must be a string type), and one whose `Args` is itself a string type now means a name. Name the query first: `LiveQueryDefinition<'todos.byId', { id: string }, Todo[]>`, or `LiveQueryDefinition<string, { id: string }, Todo[]>` to accept any name; or annotate with `typeof todoById`. `defineLiveQuery<Args, Result>` likewise became `defineLiveQuery<Name, Args, Result>`, with no defaults, so explicit type arguments name the query first as well (`defineLiveQuery<'todos.byId', { id: string }, Todo[]>({ name: 'todos.byId', args, result })`); or drop them and let the definition infer all three.

### Patch Changes

- Updated dependencies [fd11d20]
  - @velajs/client@1.26.0

## 1.22.4

### Patch Changes

- Updated dependencies [2addbe3]
  - @velajs/client@1.25.0

## 1.22.3

### Patch Changes

- Updated dependencies [4a6f5df]
  - @velajs/client@1.24.0

## 1.22.2

### Patch Changes

- Updated dependencies [5205e58]
  - @velajs/client@1.23.0

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/client@1.22.1

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/client@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/client@2.0.1

## 2.0.0

Query-isolated React hooks using shared live contracts and the Vela 2.0 client.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.0.0

### Patch Changes

- Updated dependencies [f31ac66]
  - @velajs/client@1.0.0

## 0.2.0

### Minor Changes

- 76165f0: Client infrastructure: pluggable offline mutation queue, cross-tab coordination, and local client queries.

  - **Seams** — the client factory now takes a structural `mutationStore?: MutationStore` alongside the existing injectable `fetch` and `WebSocket` seams (zero new runtime deps). These three are exactly what a `@velajs/react-native` follow-on plugs.
  - **Offline mutation queue** (`@velajs/client/offline`) — opt in with `offline`; writes issued while offline are painted optimistically, persisted, and replayed FIFO / at-least-once on reconnect (`flush()`, `pendingMutations()`, `onMutationSettled()`). Replay guards: OCC `precondition` (`createSnapshotPrecondition`), `persistenceVersion` purge, `identity` gate, terminal reject for un-encodable bodies, transport-error requeue. Ships `createMemoryMutationStore()`.
  - **Cross-tab coordination** — opt in with `crossTab`; a `BroadcastChannel` leader election makes one tab own the sockets while followers render relayed `serverBase`+cursor snapshots (one connection across N tabs), with handoff on leader death and a sole-leader no-op fallback where `BroadcastChannel` is unavailable. `isLeader()` introspection.
  - **Client queries** — `createClientQuery` + `getClientQuery`/`setClientQuery`/`subscribeClientQuery`, plus the `useClientQuery` and `usePendingMutations` React hooks.
  - **Breaking (type-only)** — removed the never-wired `OutboxSink` and `ReadCacheAdapter` stub types, superseded by the real `MutationStore` seam (the durable read cache stays a documented TODO).

### Patch Changes

- Updated dependencies [76165f0]
  - @velajs/client@0.2.0

## 0.1.1

### Patch Changes

- 2419688: Modernize the package build, validation, and release toolchain.
- Updated dependencies [2419688]
  - @velajs/client@0.1.1
