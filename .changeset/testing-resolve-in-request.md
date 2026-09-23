---
"@velajs/testing": minor
---

Add `TestingModule.resolveInRequest(token, init?)`. It resolves the token in a fresh request scope seeded from an optional `RequestInit` plus `url`, and keeps that scope open until `close()` so the returned instance and its request dependencies stay usable. `runInRequestScope(callback, init?)` accepts the same request init, and the `TestRequestInit` type is exported.

**Behavior change:** `TestingModule.get()` throws for request-scoped providers and points to `resolveInRequest()`, instead of constructing them on the root container.
