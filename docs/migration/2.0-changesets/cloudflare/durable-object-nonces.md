---
"@velajs/cloudflare": minor
---

Add a fail-closed, SQLite Durable Object-backed `NonceStore` for strict cross-isolate single-use claims. The adapter lazily resolves its binding, scopes one Durable Object by an explicit bounded application namespace, validates RPC decisions strictly, and uses an atomic `INSERT ... RETURNING` claim with bounded expiry cleanup.
