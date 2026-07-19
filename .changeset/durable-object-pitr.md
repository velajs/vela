---
"@velajs/cloudflare": minor
---

Add Durable Object point-in-time recovery (PITR) as a raw capability for the studio time-travel tier.

- `readDoPitrBookmark(storage, time?)` and `armDoPitr(storage, { bookmark?, time?, restart? })` — thin, `cloudflare:workers`-free wrappers over a SQLite DO's native bookmark API (`getCurrentBookmark` / `getBookmarkForTime` / `onNextSessionRestoreBookmark`). Storage is modeled structurally with every method optional, so a non-SQLite DO degrades to a typed `DoPitrUnavailableError` (`code: 'PITR_UNAVAILABLE'`, HTTP 409) instead of an `undefined is not a function` TypeError. `armDoPitr` resolves the target (an explicit bookmark wins over a time), arms the restore, and returns the undo bookmark — it never aborts.
- The `VelaWebSocketDurableObject` mixin gains three intra-worker-only RPC methods — `pitrCurrentBookmark()`, `pitrBookmarkForTime(time)`, `pitrArmRestore({ bookmark?, time?, restart? })` — each delegating to the wrappers over `this.ctx.storage`. `pitrArmRestore` calls `ctx.abort('vela PITR restore')` after computing the undo bookmark only when `restart` is requested. A Durable Object stub is not network-reachable (obtainable only from a Worker that binds the namespace), so the guard is the worker-side admin gate that fronts the caller — the same trust model as the existing `broadcast()` / `invalidate()` RPC.
- Exports the wrappers, the `DoPitrUnavailableError` class + `isDoPitrUnavailable` classifier (RPC-hop safe), and the PITR RPC contract types (`DoPitrStorage`, `DoPitrBookmarkRead`, `DoPitrArmOptions`, `DoPitrArmResult`, `VelaDoPitrRpc`, `DoPitrId`, `DoPitrNamespace`) so `@velajs/studio/cloudflare` can wrap them into a `TimeTravelPort`.
