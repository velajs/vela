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

Set `atomicUpsert: true` to enable scoped native upserts on SQLite, PostgreSQL,
or D1. Every configured conflict target must match a database PRIMARY KEY or
UNIQUE constraint. PostgreSQL/SQLite use transaction-bound conflict handling;
D1 uses a precomputed atomic insert/update batch and rejects hooks, soft-delete
restoration, or policies requiring callback transactions. Without this option,
existing transactional match/update/create behavior remains available. MySQL
rejects the option. Tenant, parent, and authorization predicates also constrain
the conflict update, which cannot rewrite any primary key.

Cursor tokens contain the configured cursor field plus all model primary keys.
The engine validates them before database access. Direct adapter callers pass
`options.keyset` from `resolveKeyset`, rather than a raw `options.cursor`.

The SQLite and PostgreSQL legs have regression coverage. MySQL remains
untested against a real server. D1 tests use a real workerd D1 binding through
Miniflare (`tests/crud/d1.test.ts` in the workspace).

### D1 query budgets

The adapter checks compiled D1 statements against the [100 bound parameter
limit](https://developers.cloudflare.com/d1/platform/limits/), including tenant,
authorization, write values and pagination parameters. Oversized ordinary
queries and writes fail with `QUERY_PARAMETER_LIMIT` before execution; they are
not split into separate operations that could change pagination or atomicity.
Each statement in an atomic upsert is checked before the batch starts.
Statements are prepared once so runtime defaults and update generators execute
once, and the budget covers the exact statement sent to D1. Schema-aware native
Drizzle handles are accepted without erasing their schema at the call site.

Relation includes split distinct join keys into bounded `IN` queries. Every
chunk repeats the complete tenant, authorization and soft-delete scope, and
results retain the original grouping and page metadata. An authorization
predicate that consumes the entire budget fails before any relation query.

Use the adapter's `requestScope` or `transaction` callback for direct data calls.
Adapters sharing the same native Drizzle handle can share an active callback
scope. Fabricated scopes, foreign handles and scopes retained after the callback
returns are rejected before accessing the database.
