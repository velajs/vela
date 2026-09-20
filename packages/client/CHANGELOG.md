# @velajs/client

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/live-protocol@2.0.1

## 2.0.0

Upstream Hono HTTP client exports and schema-validated live snapshots, deltas, hydration, optimistic updates and rollback.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.0.0

### Major Changes

- f31ac66: Remove bearer credentials from WebSocket URLs, add bounded short-lived socket tickets, reject preloaded credential query parameters, require account/epoch-partitioned and schema/size-bounded offline queues with same-origin targets, scope cross-tab coordination to authenticated account epochs, use collision-safe bounded subscription keys, and route hydration/relay snapshots through cloned cursor-continuity validation.

  Add `purgeOfflineMutations(previousIdentity)` as the explicit logout/account-switch boundary. It refuses to purge the currently active identity, rejects and aborts pending writes from the retired login epoch, clears only that durable partition after earlier persistence operations settle, and leaves durable data intact on ordinary `close()` for reload recovery.

## 0.2.0

### Minor Changes

- 76165f0: Client infrastructure: pluggable offline mutation queue, cross-tab coordination, and local client queries.

  - **Seams** — the client factory now takes a structural `mutationStore?: MutationStore` alongside the existing injectable `fetch` and `WebSocket` seams (zero new runtime deps). These three are exactly what a `@velajs/react-native` follow-on plugs.
  - **Offline mutation queue** (`@velajs/client/offline`) — opt in with `offline`; writes issued while offline are painted optimistically, persisted, and replayed FIFO / at-least-once on reconnect (`flush()`, `pendingMutations()`, `onMutationSettled()`). Replay guards: OCC `precondition` (`createSnapshotPrecondition`), `persistenceVersion` purge, `identity` gate, terminal reject for un-encodable bodies, transport-error requeue. Ships `createMemoryMutationStore()`.
  - **Cross-tab coordination** — opt in with `crossTab`; a `BroadcastChannel` leader election makes one tab own the sockets while followers render relayed `serverBase`+cursor snapshots (one connection across N tabs), with handoff on leader death and a sole-leader no-op fallback where `BroadcastChannel` is unavailable. `isLeader()` introspection.
  - **Client queries** — `createClientQuery` + `getClientQuery`/`setClientQuery`/`subscribeClientQuery`, plus the `useClientQuery` and `usePendingMutations` React hooks.
  - **Breaking (type-only)** — removed the never-wired `OutboxSink` and `ReadCacheAdapter` stub types, superseded by the real `MutationStore` seam (the durable read cache stays a documented TODO).

## 0.1.1

### Patch Changes

- 2419688: Modernize the package build, validation, and release toolchain.
