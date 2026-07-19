---
"@velajs/client": major
"@velajs/react-native": major
---

Remove bearer credentials from WebSocket URLs, add bounded short-lived socket tickets, reject preloaded credential query parameters, require account/epoch-partitioned and schema/size-bounded offline queues with same-origin targets, scope cross-tab coordination to authenticated account epochs, use collision-safe bounded subscription keys, and route hydration/relay snapshots through cloned cursor-continuity validation.

Add `purgeOfflineMutations(previousIdentity)` as the explicit logout/account-switch boundary. It refuses to purge the currently active identity, rejects and aborts pending writes from the retired login epoch, clears only that durable partition after earlier persistence operations settle, and leaves durable data intact on ordinary `close()` for reload recovery.
