---
"@velajs/crud": minor
---

Nested writes are now reachable end to end (hono-crud `nested-writes.ts`
parity). New `nestedWrites` flags on `RelationConfig`
(`allowCreate`/`allowUpdate`/`allowDelete`/`allowConnect`/`allowDisconnect`,
all default off) merge the relation's write shape into the derived body
schemas — CREATE accepts child payloads (single object for `hasOne`, array
for `hasMany`; the child shape omits `['id', foreignKey]` plus the parent
tenant column, which the engine force-stamps alongside defaulted timestamps
when the child schema declares them), UPDATE accepts a flag-gated ops
envelope (`create`/`update`/`delete`/`connect`/`disconnect`/`set`; `set`
requires BOTH connect and disconnect flags) — and the single create/update
verbs dispatch to the adapter's existing `NestedWriteDriver` inside the
parent write's transaction (previously the driver was unreachable). Empty
payloads are no-ops; id-only update entries are dropped; extended verbs
(batch family, upsert, clone, bulkPatch, import) reject surviving nested
payloads with a 400; live invalidation now also broadcasts the nested
relations' `crud:<relatedTable>` tags. Security note (documented +
define-time warning): `connect`/`set` relink related rows by id with no
engine-side tenant/ownership check — use database RLS on tenant-scoped
models. `belongsTo` nesting and create-via-`set` are deliberately
unsupported; audit/version capture remains parent-scoped.
