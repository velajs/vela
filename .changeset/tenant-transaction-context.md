---
"@velajs/crud": minor
"@velajs/crud-memory": minor
"@velajs/crud-drizzle": minor
---

Thread the request tenant into `adapter.transaction()`. New optional
`TransactionContext` param (`{ tenantId? }`) is passed by the engine at every
tx-open site; the drizzle adapter gains an `onOpenTransaction(tx, ctx)` config
seam so consumers can issue `SET LOCAL <guc> = <tenant>` for Postgres RLS
defense-in-depth. Additive: adapters and configs that ignore the context are
unchanged.
