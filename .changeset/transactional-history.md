---
"@velajs/crud": minor
"@velajs/crud-drizzle": minor
"@velajs/crud-memory": minor
---

Bind version history and opt-in transactional audit stores to the exact database owner, trusted tenant and current CRUD transaction. Failed writes and awaited hooks roll back snapshots and audit entries; same-owner native stores can join through a checked transaction binding.

Versioned resources now require transaction-aware persistence and a unique version identity constraint. Drizzle audit tables require an explicit tenantNamespace migration; legacy unattributed records remain excluded. Preserve default best-effort post-commit auditing and D1 precomputed atomic auditing. Add transactional memory history stores and validate audit queries and history uniqueness.
