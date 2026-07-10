---
"@velajs/crud": minor
"@velajs/crud-memory": minor
---

Add the `id: 'client'` primary-key strategy: the caller-supplied PK stays in
the derived CREATE body schema at its authored (typically required) shape —
static derivation, the per-tenant resolveSchema path, and the OpenAPI DTO all
follow — and the engine performs no generation (a create reaching the insert
seam without a PK is a 400). Update-side schemas still exclude the PK, and the
upsert/batchUpsert/import update legs never rewrite a matched row's PK (the
body PK is insert-leg identity only). A custom `dto.create` that omits the PK
under `id: 'client'` fails loudly at definition time. The memory adapter now
throws a 409 `ConflictException` on a duplicate-PK create instead of silently
overwriting. No adapter capability required; clone requires an `id` override.
Retires the erpos `ClientPkCaptureGuard` workaround.
