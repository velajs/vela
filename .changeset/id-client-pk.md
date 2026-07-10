---
"@velajs/crud": minor
---

Add the `id: 'client'` primary-key strategy: the caller-supplied PK stays
required in the derived create-body schema (static derivation, the per-tenant
resolveSchema path, and the OpenAPI DTO all follow the same exclusion gate) and
the engine performs no generation — a create reaching the insert seam without a
PK is a 400. No adapter capability required; clone under `id: 'client'`
requires an `id` in the override body. Retires the erpos
`ClientPkCaptureGuard` workaround.
