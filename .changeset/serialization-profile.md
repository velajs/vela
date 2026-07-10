---
"@velajs/crud": minor
---

Add model-level `serializationProfile` (`{ exclude }`) — hono-crud
finalize-pipeline parity. Excluded fields are removed from every response body
(list/read/create/update, batch, upsert, clone, restore, search hits, export
JSON + CSV columns, import results, and same-model embedded relation rows);
aggregate requests referencing an excluded field are rejected with a 400. The
fields stay fully writable and intact at storage — filters and sorts match
them, persistence-side lifecycle hooks and version/audit snapshots see the
full row — and the strip wins over `?fields=` and
`fieldSelection.alwaysInclude`. Response-transform hooks
(`transformRead`/`transformList`) run after the strip, per hono-crud's
profile-before-transform order. Proven by the new finalize-pipeline
conformance cell over the memory and drizzle adapters.
