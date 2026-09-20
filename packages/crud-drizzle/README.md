# @velajs/crud-drizzle

Drizzle adapter for Vela CRUD: PostgreSQL, MySQL, SQLite, and Cloudflare D1.

```ts
import { drizzle } from 'drizzle-orm/d1';
import { drizzleAdapter } from '@velajs/crud-drizzle';

const adapter = drizzleAdapter({
  driver: 'd1',
  db: drizzle(env.DB),
  table: items,
  softDeleteField: 'deletedAt',
  parseRow: (value) => itemSchema.parse(value),
});
```

`parseRow` validates returned rows and infers the adapter row type. Without a
decoder, rows are `Record<string, unknown>`; supplying a generic cannot invent a
row shape. Related rows retain their own record representation.

`requestScope` provides ordinary data access without a rollback promise.
`transaction` is reserved for callbacks that need atomicity. For SQL drivers,
`onOpenTransaction` still opens a real transaction for read scopes so
transaction-local tenant/RLS settings govern every statement. D1 configuration
forbids that option and never calls Drizzle's unsupported callback transaction.

D1 supports scoped create, read, list, update, and delete. Updates and deletes
use one `RETURNING` statement, including soft deletes and tenant predicates.
Aggregate/search/export read paths also use request scopes. Updates/deletes
with row-dependent write policies, hooks, versioning, audit snapshots, ETags,
or cascades require callback transactions and fail with
`TRANSACTION_UNSUPPORTED` before writing. Create after-hooks, nested writes,
and synthesized batch/upsert/restore/clone workflows likewise reject when
they require rollback. An operation-level policy still authorizes ordinary
D1 writes. Audit capture following a successful create remains a separate
post-write action, as on the SQL adapters.

D1 has atomic SQL batches; those do not provide a transaction that can pause
for JavaScript policy checks or hooks. This adapter does not emulate that
missing guarantee. See [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

Cursor tokens contain the configured cursor field plus all model primary keys.
The engine validates them before database access. Direct adapter callers pass
`options.keyset` from `resolveKeyset`, rather than a raw `options.cursor`.

The SQLite and PostgreSQL legs have regression coverage. MySQL remains
untested against a real server. D1 tests use a real workerd D1 binding through
Miniflare (`tests/crud/d1.test.ts` in the workspace).
