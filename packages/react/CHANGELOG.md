# @velajs/react

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
