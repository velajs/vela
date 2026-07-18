---
"@velajs/crud": major
"@velajs/crud-drizzle": major
"@velajs/crud-memory": major
---

Route every CRUD verb through uniform tenant and operation-policy enforcement, default resources to the core five endpoints, remove the tenant-selector trust bypass, require explicit aggregate operation/field authorization, cap fallback scans (including export), authorize includes and versions, inspect and authorize every nested-write target in-transaction, enforce target create/write policies, strip managed fields, and harden aggregate/search/import output. Existing-row mutations now require both source `read` and `write`, every single-row response rechecks `read`, and arbitrary read predicates paginate only after a bounded authorization scan so hidden counts/page existence cannot leak. Query-filter and native Drizzle aggregate dictionaries use null prototypes and own-property access; prototype keys and unsafe/colliding aggregate aliases are rejected fail-closed.

Version-store keys now contain a trusted tenant namespace and canonical full primary-key tuple. The `VersioningStore` interface therefore takes a `VersionRecordKey` for every operation; legacy table/id-only rows intentionally fail closed and must be migrated by an application that can prove their tenant ownership. Tenant-scoped native upserts no longer use an unscoped conflict target, and bulk patch confirmation plus mutation now share one transaction (or operate on a fixed enumerated row set).

Cross-model relation response metadata now carries the target tenant field, soft-delete field, timestamps, and primary keys. `defineModels()` wires these automatically; external nested-create relations must declare `response.primaryKeys`. IDs, tenancy, soft-delete markers, and timestamps are stripped again after custom DTO parsing, while includes and nested existing-row operations use the target model's metadata rather than the parent model's column names.

Search highlights are returned as untrusted text plus structured `{ start, end }` ranges instead of HTML fragments. Clients that still render `<mark>` tags must HTML-escape the text before applying those ranges.
