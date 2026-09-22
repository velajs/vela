# Atomic writes and audit persistence

## Additional insert commands

`drizzleInsertCommand({ db, table, values, parseRows, onOpenTransaction? })` from
`@velajs/crud-drizzle` prepares an unconditional insert for an existing atomic
batch. It copies the values, rejects unknown columns, and authenticates the exact
native database owner and transaction initializer before executing any writes.
`parseRows` synchronously validates the returned rows. An insert can persist an
outbox event alongside an unconditional business insert in the same batch.

This command does not make its execution conditional on an earlier update finding
a row. Use a real callback transaction for result-dependent admission. A decoder
failure rolls back callback transactions; after a native D1 batch commits it
raises `AtomicBatchResultError` with `committed: true`, so callers must not blindly
retry the write. SQL constraint failures roll back the entire batch on both paths.

`@velajs/crud` exposes an optional `atomicBatch` adapter capability for **precomputed
writes**. Every command in a batch commits or rolls back together. This capability
is separate from `transactions`, which permits interactive callback work, and
`atomicMutations`, which describes a single atomic update/delete statement.

`@velajs/crud-drizzle` implements batches with one native D1 `db.batch()` call, or
one native asynchronous SQLite/PostgreSQL transaction (tested with libsql and
PGlite). MySQL and synchronous SQLite drivers do not advertise this capability.
The SQL driver must support real asynchronous callback transactions. D1 never
emulates them. Native database handles remain available for database-specific work.

## Custom services

Commands are prepared without executing SQL. Supply related table adapters and
an optional `DrizzleAuditStore` with the **same exact native Drizzle handle**.
Two connections to the same database, or a shared `transactionOwner` label, do
not make commands interchangeable. The executor authenticates all commands and
rejects foreign/fabricated commands before any write. A schema parser preserves
and validates the command's result type.

```ts
import { executeAtomicBatch, requireAtomicBatch } from '@velajs/crud';
import { drizzleAdapter, DrizzleAuditStore } from '@velajs/crud-drizzle';

// db is your native Drizzle handle. Tables and row schemas are application-owned.
const entries = drizzleAdapter({ db, table: entryTable, parseRow: value => entrySchema.parse(value) });
const details = drizzleAdapter({ db, table: detailTable, parseRow: value => detailSchema.parse(value) });
const audit = new DrizzleAuditStore(db, auditTable);
const entryWrites = requireAtomicBatch(entries);
const detailWrites = requireAtomicBatch(details);
const id = crypto.randomUUID();

const [entry, detail] = await executeAtomicBatch(entries, [
  entryWrites.create({ id, tenantId, title: 'New entry' }, {
    audit: audit.atomic.prepare({
      id: crypto.randomUUID(), timestamp: new Date(), action: 'create',
      tableName: 'entries', recordId: id, userId,
      metadata: { tenantId },
    }),
  }),
  detailWrites.create({ id: crypto.randomUUID(), entryId: id, tenantId, text: 'Details' }),
], { tenantId });
```

For D1, construct each adapter with `{ driver: 'd1', db, table, ... }`.
An ordinary JavaScript array can contain multiple resource command types;
`executeAtomicBatch` and `driver.execute` infer a positional result tuple.
`create` returns the inserted row. `update` and `delete` return a row or `null`
when no visible row matches. They require a complete primary-key `Lookup`:

```ts
const [updated] = await entryWrites.execute([
  entryWrites.update({
    field: 'id', value: id,
    filters: { tenantId },
    predicate: { op: 'eq', field: 'status', value: 'draft' },
  }, { title: 'Revised' }, { audit: audit.atomic.prepare(updateAuditEntry) }),
]);
```

The tenant filter and authorization predicate run in the mutation SQL. A miss
is a successful no-op (`null`), not a reason to roll back the other commands.
Its attached audit command is skipped in the same database boundary. On D1 this
uses an adjacent `INSERT ... SELECT ... WHERE changes() > 0`. A standalone
`audit.atomic.prepare(entry)` command in the batch is unconditional. Supplied
audit snapshots are caller-provided data; this API does not capture a previous
record snapshot from a pre-read.

Generic commands are a data-access API: custom services must validate input and
supply trusted tenant/authorization predicates themselves. Passing `{ tenantId }`
to execution supplies transaction context to a configured SQL
`onOpenTransaction`; it does not add filters. All write adapters in the batch
must share the same initializer function. CRUD resources add their trusted
scopes automatically. No ambient database or tenant state is used.

An empty batch returns `[]` without opening a transaction. Sparse or malformed
command arrays fail. Prepared command inputs are copied, so later caller
mutation cannot change them. Commands are not idempotency keys: executing a
command twice attempts the write twice.

## Opt-in CRUD auditing

**Atomic CRUD auditing currently stores identity and context only. It does not
store record snapshots, previous records, or field diffs.** This choice is
mandatory and explicit:

```ts
const resource = defineResource('entries', {
  model, // defineModel({ ..., audit: true })
  adapter: entries,
  auditStore: audit,
  auditPersistence: { mode: 'atomic', snapshots: 'none' },
});
```

Core `create`, `update`, and `delete` are supported, including soft delete.
Each successful write records action, table, record ID, timestamp, user ID, and
metadata containing `snapshots: 'none'` and the trusted tenant ID when present.
Audit record IDs normalize primary-key values to strings, including compound keys.
Tenant/collection scope and structured authorization predicates are enforced in
SQL. A scoped miss returns the ordinary CRUD not-found response and creates no
audit entry. Audit failure rolls back the write. Store and adapter must own the
same native handle, including when registered in a named database.

Configuration rejects database-generated IDs (generate IDs before preparing the
batch), versioning, ETags, mutation hooks, JavaScript row write policies, nested
writes, and cascades. These need a different interactive or database-native
workflow. Other mutation verbs and joining an existing `CrudTransactionScope`
reject before writes. Input-only create policies and structured SQL authorization
remain supported. There is no fallback to post-commit audit persistence.

Without `auditPersistence`, or with `{ mode: 'postCommit' }`, existing behavior is
unchanged: the engine captures the usual snapshots and awaits the audit store
after commit. A failure there cannot roll back the already committed mutation.

The Drizzle audit table uses the existing ten columns: `id`, `timestamp`,
`action`, `tableName`, `recordId`, `userId`, `record`, `previousRecord`, `changes`,
`metadata`. Atomic preparation requires exactly these column keys; use the
existing text/epoch-millisecond store schema and your own migrations. Other
stores may implement `AuditStore.atomic` and a compatible adapter command
issuer; `MemoryAuditStore` intentionally does not.

## Failure and result boundaries

Constraint failures in any SQL command, including an audit insert, roll back all
writes and audit rows. Drizzle SQL `parseRow` decoders run inside the transaction
and can also roll it back. D1 returns results after its batch has committed; a
decoder failure raises `AtomicBatchResultError` with `committed: true`. Do not
retry it as if the write rolled back. CRUD row contracts and response shaping
also run after an atomic batch completes; CRUD row-contract failures use the
same committed error. Enforce data invariants with SQL constraints or validated
inputs when they must prevent commit.

After-commit events/cache delivery happen outside the atomic boundary. Delivery
errors go to `onAfterCommitError` (or logging) and do not change successful CRUD
write results. Result decoding failures can prevent delivery, so consumers that
need durable delivery should use a database outbox in the same write batch.

D1 prepares each exact statement once, including runtime defaults, and enforces
the existing bound-parameter limit before sending any statement. It never splits
a batch into independent commits; a batch exceeding native platform limits fails
as one unit. Result-dependent JavaScript checks and callback transactions remain
unsupported on D1. Use SQL predicates for conditions, or reject the workflow.
