---
'@velajs/studio': minor
'@velajs/studio-protocol': minor
---

Use the shared CRUD database resolver for Studio resources, expose qualified database/resource identities, and reject ambiguous legacy names or invalid explicit selections. Keep relation inspection and generated foreign keys within the selected database. Preserve native compiled CRUD adapters and fail before writes when time-based CDC replay would require an unavailable database-aware change source.
