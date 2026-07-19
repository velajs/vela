# @velajs/crud

Native CRUD for the [Vela framework](https://github.com/velajs/vela) — a full resource engine
(22 verbs, filtering, pagination, relations + nested writes, hooks, policies, per-endpoint
guards, multi-tenant, unique constraints, ETag/If-Match, serialization profiles,
versioning/audit, OpenAPI, live queries) built the Vela way: decorators, DI, guards, and
Zod DTOs.

This repository is a pnpm workspace:

| Package | Description |
| --- | --- |
| [`@velajs/crud`](packages/core) | The engine + Vela module (`@Crud()`, `CrudModule`, `@Override()`) |
| [`@velajs/crud-memory`](packages/memory) | In-memory adapter — tests, prototypes, examples |
| [`@velajs/crud-drizzle`](packages/drizzle) | Drizzle ORM adapter (pg, mysql, sqlite) |

## Development

```bash
pnpm install
pnpm -r typecheck && pnpm -r build && pnpm test
```

Releases are managed with [changesets](https://github.com/changesets/changesets); the three
packages version together as a fixed group.

## Security migration

The next major release defaults `@Crud()` to `create`, `list`, `read`, `update`, and
`delete`. Every extended verb must appear in `only`. Tenant-scoped models require a
non-empty server context, and header/path/query/custom tenant selectors require a
`multiTenant({ validate })` membership check; there is no trust bypass.

All executors evaluate `model.policies.operation` before parsing or storage access.
Aggregate routes additionally require that policy to be present, and every named
aggregate/group field must appear in its operation-specific allowlist (`countFields`,
`sumFields`, `avgFields`, `minMaxFields`, `countDistinctFields`, or `groupByFields`).
Fallback policy scans stop at 1,000 rows; larger policy-sensitive operations require an
adapter with database-enforced isolation.

Nested writes now use an inspect-then-mutate adapter contract inside the parent
transaction. Existing children must satisfy the trusted tenant scope and the target
model's `write` policy for update, delete, connect, disconnect, and both sides of
`set`; nested children must satisfy the target model's `create` policy. Missing,
foreign-tenant, unowned, or incompletely inspected targets deny before the parent
write. Custom adapters must implement `NestedWriteDriver.inspectNestedTargets`.
`defineModels()` now wires each target's tenant, soft-delete, timestamp, and
primary-key metadata. External relations that allow nested creates must declare
`response.primaryKeys` and `response.timestamps` (use explicit `false` fields
when unmanaged); target IDs and all managed fields are stripped again after
custom DTO parsing.

`VersioningStore` is a major-version contract change: every method receives a
`VersionRecordKey` containing the trusted tenant namespace and canonical full
primary-key tuple. Legacy table/id-only entries are not read automatically;
applications may migrate them only when tenant ownership can be proven.

Search highlights are structured as `{ text, ranges: [{ start, end }] }` and
never contain framework-generated HTML. Escape `text` before rendering any
compatibility `<mark>` tags. Bulk confirmation/counting and mutation share a
transaction for atomic adapters; fallback adapters mutate only a fixed,
policy-checked row set.

## License

MIT
