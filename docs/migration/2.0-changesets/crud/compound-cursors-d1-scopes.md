---
'@velajs/crud': major
'@velajs/crud-drizzle': major
'@velajs/crud-memory': major
---

Validate compound keyset cursors before adapter access and append every primary key to the ordering so nonunique cursor fields cannot skip rows. Use the same ordering for read-policy pagination, with tenant-scoped totals and explicit null ordering.

Separate required `requestScope` from callback transactions. Add explicit Drizzle D1 configuration and atomic single-statement CRUD. Reject workflows requiring callback transactions before writing; preserve transaction-local tenant setup on reads for SQL adapters. Typed adapters now infer rows from an explicit `parseRow` decoder instead of unchecked generic assertions.

Breaking: custom adapters must implement `requestScope`; adapter list calls receive validated `keyset` data; old cursor tokens must be discarded. Supply `parseRow` to infer a narrower row type. D1 cannot run rollback-dependent hooks, nested writes, batch workflows, or updates/deletes requiring pre-read policy/concurrency decisions.

Resource and controller hooks now infer their data from the model schema. Persisted records and hook replacements are validated before entering typed author callbacks, while sparse writes and shaped reads remain partial and arbitrary read/list transforms remain supported. Compiled resources have no caller-selected row generic. Wrap headless registrations in `defineCrudFeature(...)`, and bind custom runtime adapters with `bindAdapter(...)`. CRUD providers and DTO metadata use Vela's new descriptor APIs.
