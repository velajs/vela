---
"@velajs/crud": minor
---

Add model-level `serializationProfile` (`{ exclude }`) — hono-crud
finalize-pipeline parity. Excluded fields are removed from every response body
(list/read/create/update, batch, upsert, clone, restore, search hits, export
JSON + CSV columns, import results) while staying fully writable and intact at
storage (filters, sorts, hooks, and version/audit snapshots see the full row);
`?fields=` cannot resurrect an excluded field. Proven by the new
finalize-pipeline conformance cell over the memory and drizzle adapters.
