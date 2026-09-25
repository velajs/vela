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
with row read/write policies (including `readPushdown`), hooks, versioning, or
audit snapshots require callback transactions and fail with
`TRANSACTION_UNSUPPORTED` before writing. Create after-hooks, nested writes,
and synthesized batch/upsert/restore/clone workflows likewise reject when
they require rollback. An operation-level policy still authorizes ordinary
D1 writes. ETag resources require `transactions` and `rowLocks` and reject D1
at definition time. Audit capture following a successful create remains a separate
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

Database handles retain their original schema type when registered using
`defineCrudDatabase` from `@velajs/crud`. Schema-aware Drizzle handles are accepted
by the adapter's reflection boundary. Callback scopes are validated against the
native owner and expire when their callback exits. Adapters sharing the exact
handle can compose resource operations through `crudTransaction`; native storage
wrappers may supply `transactionOwner` for a single shared physical boundary.
D1 callback transactions remain unsupported. See
[multiple databases](../../docs/multi-database.md) for registration, defaults,
raw native access and migration ownership.

## Atomic write batches and auditing

Drizzle adapters advertise `atomicBatch` for D1 and asynchronous SQLite/PostgreSQL
handles. D1 uses one native batch; SQL uses a real transaction. MySQL and
synchronous SQLite handles do not advertise this capability. Commands from
related tables and `DrizzleAuditStore.atomic.prepare(entry)` must use the exact
same native Drizzle handle. Attached audit commands are conditional on the write
matching a row, and an audit failure rolls back the complete batch.

CRUD's opt-in `auditPersistence: { mode: 'atomic', snapshots: 'none' }` captures
identity/context only; it never claims a previous-record snapshot from an outside
read. See the [atomic write guide](../../docs/atomic-writes.md) for typed service
examples, schema requirements, and limitations.


`DrizzleVersioningStore` and `DrizzleAuditStore` expose same-owner history bindings
for asynchronous SQLite/libsql and PostgreSQL. Version tables require a declared
and migrated `UNIQUE(tableName, recordId, version)`; audit tables require a
`tenantNamespace` column without inferred attribution of legacy rows. See
[transactional history](../../docs/transactional-history.md) for migrations and
`drizzleTransactionStore` for trusted native store operations.

ETag updates hold a database write lock from the If-Match check through commit.
PostgreSQL/MySQL use `SELECT FOR UPDATE`; asynchronous SQLite relies on its
transaction write isolation. Custom adapters must advertise `rowLocks` only when
`readOne(..., { forUpdate: true }, scope)` protects the row until commit/rollback.
Use database foreign-key actions for hard-delete cascades and restrictions.
CRUD relation metadata does not configure database constraints.
