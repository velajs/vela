# @velajs/crud

Native CRUD for the [Vela framework](https://github.com/velajs/vela) — a full resource engine
(22 verbs, filtering, pagination, relations + nested writes, hooks, policies, per-endpoint
guards, multi-tenant, unique constraints, ETag/If-Match, serialization profiles,
versioning/audit, OpenAPI, live queries) built the Vela way: decorators, DI, guards, and
Zod DTOs.

The CRUD packages share the Vela workspace:

| Package | Description |
| --- | --- |
| [`@velajs/crud`](../../packages/crud) | The engine + Vela module (`@Crud()`, `CrudModule`, `@Override()`) |
| [`@velajs/crud-memory`](../../packages/crud-memory) | In-memory adapter — tests, prototypes, examples |
| [`@velajs/crud-drizzle`](../../packages/crud-drizzle) | Drizzle ORM adapter (pg, mysql, sqlite) |

## Development

```bash
pnpm install
pnpm build
pnpm test:conformance
```

See [the contributor guide](../../CONTRIBUTING.md) for development checks and
[the release guide](../../RELEASING.md) for versioning and publication.

## Authorization and data safety

Generated routes run the global and class guard pipeline like any controller. Declare
authorization metadata on a headless resource's generated controller with its
`decorators` (the class) and `endpointDecorators` (each endpoint), such as
`[RequireResource({ ... })]` or `[CedarPublic()]` under Cedar's default deny.

`@Crud()` defaults to `create`, `list`, `read`, `update`, and
`delete`. Every extended verb must appear in `only`. Tenant-scoped models require a
non-empty server context, and header/path/query/custom tenant selectors require a
`multiTenant({ validate })` membership check; there is no trust bypass.

All executors evaluate `model.policies.operation` before parsing or storage access.
Aggregate routes additionally require that policy to be present, and every named
aggregate/group field must appear in its operation-specific allowlist (`countFields`,
`sumFields`, `avgFields`, `minMaxFields`, `countDistinctFields`, or `groupByFields`).
Fallback policy scans stop at 1,000 rows; larger policy-sensitive operations require an
adapter with database-enforced isolation.

Nested writes use an inspect-then-mutate adapter contract inside the parent
transaction. Existing children must satisfy the trusted tenant scope and the target
model's `write` policy for update, delete, connect, disconnect, and both sides of
`set`; nested children must satisfy the target model's `create` policy. Missing,
foreign-tenant, unowned, or incompletely inspected targets deny before the parent
write. Custom adapters must implement `NestedWriteDriver.inspectNestedTargets`.
`defineModels()` wires each target's tenant, soft-delete, timestamp, and
primary-key metadata. External relations that allow nested creates must declare
`response.primaryKeys` and `response.timestamps` (use explicit `false` fields
when unmanaged); target IDs and all managed fields are stripped again after
custom DTO parsing.

Every `VersioningStore` method receives a `VersionRecordKey` containing the
trusted tenant namespace and canonical full primary-key tuple. Store lookups
must preserve that scope.

Search highlights are structured as `{ text, ranges: [{ start, end }] }` and
never contain framework-generated HTML. Escape `text` before rendering any
`<mark>` tags. Bulk confirmation/counting and mutation share a
transaction for atomic adapters; fallback adapters mutate only a fixed,
policy-checked row set.

## Read and mutation contracts

Relations are included only when named in `allowedIncludes`; omitted or empty
allowlists deny every include on both read and list. `beforeRead` runs before
lookup, and `afterRead` receives an authorized detached row before response shaping.
Read hooks cannot mutate stored rows; ETags remain based on the stored representation.

`bulkPatch` accepts only allowlisted filter fields and operators. Invalid filters,
non-string values, and list options such as `search`, `page`, or `include` return
400 before any write. An omitted or empty filter intentionally selects all rows
subject to tenant, policy, size and confirmation checks.

`etag: true` requires adapters declaring both `transactions` and `rowLocks`.
Updates lock before checking `If-Match` and keep the lock through commit. Plain
memory and D1 adapters reject this configuration; use transactional memory,
PostgreSQL, asynchronous SQLite, or the Durable Object SQLite adapter.

Relation `cascade`, `CascadeConfig`, and the adapter `CascadeDriver` are removed.
Configure hard-delete `CASCADE`, `RESTRICT`, and `SET NULL` in database foreign keys.
Implement soft-delete propagation as explicit transactional hooks with child
policy and tenant checks. Studio's CRUD source cannot preview database cascades;
a custom database-aware source may provide `cascadePreview`.

## License

MIT
