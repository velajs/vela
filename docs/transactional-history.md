# Transactional history and auditing

Versioning stores participate in the same callback transaction as resource rows.
An awaited hook failure, failed database write, duplicate version, or later failure
in a composed transaction rolls back both. Versioned resources require a store
with a transaction binding owned by the exact same database as the adapter.
Unsupported combinations fail before mutation hooks or writes.

```ts
import { crudTransaction, defineResource, withCrudTransactionStore } from '@velajs/crud';
import { DrizzleAuditStore, DrizzleVersioningStore } from '@velajs/crud-drizzle';

const versions = new DrizzleVersioningStore(db, versionTable);
const audit = new DrizzleAuditStore(db, auditTable);
const resource = defineResource('entries', {
  model, // versioning: true, audit: true; multiTenant: true for tenant-owned rows
  adapter, // created with this exact db object
  versioningStore: versions,
  auditStore: audit,
  auditPersistence: { mode: 'transaction' },
});

await crudTransaction(adapter, { tenantId }, async (transaction) => {
  await resource.execute('update', {
    transaction, vars: { tenantId }, id: 'entry-1', body: { title: 'Revised' },
  });
  await resource.execute('versionRead', {
    transaction, vars: { tenantId }, id: 'entry-1', params: { version: '1' },
  });
  await withCrudTransactionStore(transaction, audit.transaction!, { tenantId }, async (store) => {
    const entries = await store.query({ recordId: 'entry-1' });
    // This reads the current transaction's audit entries in its trusted tenant.
  });
});
```

An individual history-enabled resource operation opens its own transaction when
no outer transaction is supplied. History reads, rollback, and mutation capture
use bound stores throughout the operation. Create initializes the managed
`version` field to 1. Updates snapshot the previous version and increment the
row's counter; soft deletion and restoration also advance the counter. Batch,
upsert, import updates, and bulk patching use row capture rather than bypassing it
through an opaque native bulk operation. Invalid import rows may still be
explicitly skipped; persistence failures abort a history-enabled import.
Rollback captures the current row before restoring the selected snapshot.
Version conflicts return HTTP 409; retry the complete operation in a fresh
transaction after rereading its state. Version counters must be nonnegative
safe integers. Reusing a deleted identifier while retaining its old version
sequence requires an explicit application migration; snapshots are never silently
overwritten.

## Persistence modes

- `auditPersistence: { mode: 'transaction' }` saves audit entries before commit.
  The audit store must participate in the same owned callback transaction.
- `auditPersistence: { mode: 'postCommit' }`, the default, awaits best-effort audit
  delivery after commit. Delivery errors are logged and cannot reverse a write.
  During composition, delivery waits for the outer commit and is discarded on
  rollback.
- `{ mode: 'atomic', snapshots: 'none' }` retains precomputed metadata-only atomic
  auditing, including D1. See [atomic writes](atomic-writes.md). D1 has no callback
  transactions and cannot run versioned or transactional-snapshot operations.

Drizzle history bindings support asynchronous SQLite/libsql and PostgreSQL.
Synchronous SQLite and MySQL history bindings are unsupported. Use
`transactionalMemoryVersioningStore(memoryStore)` and
`transactionalMemoryAuditStore(memoryStore)` from `@velajs/crud-memory` with the
same `MemoryStore` as `transactionalMemoryAdapter` for serialized copy-on-write
transactions. Standalone `MemoryVersioningStore` and `MemoryAuditStore` remain
usable independently; the former can no longer be attached to a versioned
resource because it cannot roll back alongside a separate adapter.

Transaction contexts come from trusted server identity. A bound history store
only permits its transaction's tenant namespace. For a model without tenant
ownership, the engine explicitly selects global history while preserving the
transaction's authenticated tenant and native session context. Requests cannot supply native database handles, bindings, or
owner identities.

## Schema migration

Version tables retain their existing columns and v2 `recordId` encoding, which
contains the tenant namespace and complete typed primary-key tuple. They now
require an immediate, unconditional unique constraint on
`(tableName, recordId, version)`, in both the Drizzle table declaration and the
physical database. The store checks both before resource writes. For example:

```ts
// SQLite: sqliteTable(...); PostgreSQL: pgTable(...) or schema.table(...)
(t) => [uniqueIndex('version_identity').on(t.tableName, t.recordId, t.version)]
```

```sql
-- SQLite
CREATE UNIQUE INDEX version_identity ON versions(tableName, recordId, version);
ALTER TABLE audits ADD COLUMN tenantNamespace TEXT;

-- PostgreSQL (adjust schema/table names to your migration)
CREATE UNIQUE INDEX version_identity ON versions("tableName", "recordId", version);
ALTER TABLE audits ADD COLUMN "tenantNamespace" TEXT;
```

Inspect and resolve historical duplicate version tuples using authoritative
application records before adding the index. Do not discard duplicates blindly.
Unscoped legacy version rows remain unreachable from v2 keys. Do not infer their
tenants from a coincidentally matching current record identifier.

The audit table now has eleven Drizzle properties: `id`, `tenantNamespace`,
`timestamp`, `action`, `tableName`, `recordId`, `userId`, `record`,
`previousRecord`, `changes`, and `metadata`. Use the existing text/JSON and epoch
millisecond representation; PostgreSQL epoch columns should use bigint in number
mode. Update the Drizzle declaration as well as the migration. Atomic audit
preparation requires exactly these properties.

**Do not add a global default or infer tenant attribution for legacy audit rows.**
The new column should remain NULL for old records until an explicit, verified
migration establishes their scope. Queries exclude NULL legacy rows. New entries
use `global` for global history and `tenant:<JSON-encoded tenant ID>` for tenant
history. A tenant literally named `global` therefore has a different namespace.
Audit queries default to the global namespace rather than querying all tenants;
a bound store derives its namespace from the trusted transaction. Standalone
administrative queries may explicitly supply `tenantNamespace` after authorizing
that scope. Date ranges and pagination must be valid, and pagination values must
be nonnegative safe integers.

## Native store integrations

`TransactionStoreBinding<Store>` has an exact `owner` and
`bind(scope, context, onError)`. It is a trusted store-author interface, not a
request DTO. Every bound operation must check the scope's lifetime and report
failures through `onError`, even when its caller catches the error. Wrap every
asynchronous bound operation in `onError.track(work)` when that tracker is
provided. This prevents unawaited store methods from outliving a transaction.
Forward the observer unchanged through binding wrappers so its tracker survives.

`drizzleTransactionStore(db, (run, context) => store)` supplies a checked runner:

```ts
const binding = drizzleTransactionStore(db, (run, context) => ({
  append: (input: ValidatedEntry) => run(async (native) => {
    // Derive tenant fields from context; validate input before inserting.
    await native.insert(entryTable).values({ ...input, tenantId: context.tenantId });
  }),
}));
await withCrudTransactionStore(transaction, binding, trustedContext,
  (store) => store.append(validatedEntry));
```

Every bound method must call `run` and await its native operations. Perform
row-count/fence checks inside that callback so their errors also force rollback.
Do not retain the native database outside `run`. The runner validates native
owner and lifetime on each invocation. Await store/resource operations
sequentially; overlapping or unawaited helper callbacks force rollback. External
side effects and fire-and-forget hooks are outside database rollback guarantees.
