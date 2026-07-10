---
"@velajs/crud": minor
---

Nested writes are now reachable end to end (hono-crud `nested-writes.ts`
parity). New `nestedWrites` flags on `RelationConfig`
(`allowCreate`/`allowUpdate`/`allowDelete`/`allowConnect`/`allowDisconnect`,
all default off) merge the relation's write shape into the derived body
schemas — CREATE accepts child payloads (array for `hasMany`; the child shape
omits exactly `['id', foreignKey]`), UPDATE accepts a flag-gated ops envelope
(`create`/`update`/`delete`/`connect`/`disconnect`/`set`) — and the single
create/update verbs dispatch to the adapter's existing `NestedWriteDriver`
inside the parent write's transaction (previously the driver was unreachable:
validation stripped relation keys before dispatch). Extended verbs (batch
family, upsert, clone, bulkPatch, import) reject nested payloads with a 400
instead of silently inserting relation columns. `belongsTo` nesting and
create-via-`set` are deliberately unsupported (definition-time error and
documented deviation respectively).
