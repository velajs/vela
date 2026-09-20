# @velajs/react-native

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/client@2.0.1
  - @velajs/react@2.0.1

## 2.0.0

React Native bindings aligned with the Vela 2.0 client and shared live contracts.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.0.0

### Major Changes

- f31ac66: Remove bearer credentials from WebSocket URLs, add bounded short-lived socket tickets, reject preloaded credential query parameters, require account/epoch-partitioned and schema/size-bounded offline queues with same-origin targets, scope cross-tab coordination to authenticated account epochs, use collision-safe bounded subscription keys, and route hydration/relay snapshots through cloned cursor-continuity validation.

  Add `purgeOfflineMutations(previousIdentity)` as the explicit logout/account-switch boundary. It refuses to purge the currently active identity, rejects and aborts pending writes from the retired login epoch, clears only that durable partition after earlier persistence operations settle, and leaves durable data intact on ordinary `close()` for reload recovery.

### Patch Changes

- Updated dependencies [f31ac66]
  - @velajs/client@1.0.0
  - @velajs/react@1.0.0

## 0.2.0

### Minor Changes

- 99dec7e: Add `@velajs/react-native`: the React Native / Expo binding. A thin composition over `@velajs/client` and `@velajs/react` — an AsyncStorage-backed offline `MutationStore` (`createAsyncStorageMutationStore`), a native-tuned client factory (`createNativeClient`) that maps `storage` to that store and defaults the offline queue on, the react-dom-free `@velajs/react` hook surface re-exported unchanged, and a `@velajs/react-native/auth` better-auth Expo bridge behind optional peers. The native bearer auth story (Bearer header on HTTP, `?token=` on the live socket) rides the existing `LiveClientOptions.authToken` seam with zero core changes.

### Patch Changes

- Updated dependencies [76165f0]
  - @velajs/client@0.2.0
  - @velajs/react@0.2.0
