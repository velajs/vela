---
"@velajs/crud": minor
"@velajs/crud-memory": minor
"@velajs/crud-drizzle": minor
---

ETag/If-Match optimistic concurrency and unique-constraint enforcement
(hono-crud parity, closing the last two deferred conformance cells).
`etag: true` on a resource makes reads emit a strong content-hash `ETag`
(computed→mask→profile representation, stable across `?fields=`) and honor
`If-None-Match` (304, empty body); updates honor `If-Match` and reject a
stale tag with 409 CONFLICT (hono-crud's actual behavior — not 412). Model
`unique` tuples (global scope; soft-deleted rows occupy the slot; null
values never conflict) require the new `uniqueConstraints` adapter
capability: the memory adapter enforces natively on create/update, and the
drizzle adapter translates database unique-violations (sqlite/pg/mysql
shapes) to 409 `ConflictException` — closing the constraint→409 concern for
the in-repo adapters.
