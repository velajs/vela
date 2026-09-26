# @velajs/reliability

Durable idempotency, outbox delivery, inbox deduplication and one-off scheduling.
Each feature works independently. The root package, `/http` and `/testing` use
Web APIs and have no runtime dependencies. `/drizzle` is an optional integration
for PostgreSQL, asynchronous SQLite/libsql and native D1 statements.

Execution is **at least once**. A process can fail after an external effect and
before recording completion. Lease expiry permits another worker to run that
work again. Database fences reject stale completion; they cannot make an
external HTTP request, email or payment exactly once. Pass a stable downstream
idempotency key when the destination supports one.

## Vela dependency injection

Keep the store and each configured feature as ordinary typed providers. This
preserves the feature's payload and transaction types without a module facade:

```ts
import { defineProvider, Inject, Injectable, InjectionToken, Module } from '@velajs/vela';
import { createOutbox, type ReliabilityStore } from '@velajs/reliability';

const STORE = new InjectionToken<ReliabilityStore>('delivery store');
function deliveryOutbox(store: ReliabilityStore) {
  return createOutbox({ store, parsePayload: (value) => eventSchema.parse(value) });
}
const OUTBOX = new InjectionToken<ReturnType<typeof deliveryOutbox>>('delivery outbox');

@Injectable()
class Delivery {
  constructor(@Inject(OUTBOX) readonly outbox: ReturnType<typeof deliveryOutbox>) {}
}

@Module({
  imports: [DeliveryStoreModule], // Exports STORE; eventSchema validates application events.
  providers: [defineProvider(OUTBOX, { inject: [STORE], useFactory: deliveryOutbox }), Delivery],
  exports: [Delivery],
})
class DeliveryModule {}
```

Use `ReliabilityStore<YourTransaction>` when sharing a native transaction. Create
the store through the application's environment-specific factory, and pass the
trusted tenant/namespace scope to operations. Injecting a service does not infer
that authority. The same composition applies to inboxes, idempotency and jobs;
no background polling starts merely because the provider was registered.

## Storage and namespaces

```ts
import { createOutbox } from '@velajs/reliability';
import {
  createDrizzleReliabilityStore,
  reliabilityPgTable,
} from '@velajs/reliability/drizzle';

// db is an application-owned native Drizzle handle.
export const deliveryTable = reliabilityPgTable('delivery');
const store = createDrizzleReliabilityStore({
  db, table: deliveryTable, dialect: 'pg',
});
const outbox = createOutbox({
  store,
  parsePayload: value => eventSchema.parse(value),
});
const scope = { tenantId: admittedTenantId, namespace: 'entry-events' };
```

Install `@velajs/crud`, `@velajs/crud-drizzle` and `drizzle-orm` when importing
`/drizzle`. None is loaded by the portable entrypoints. Root types remain generic
over the selected store's transaction token.

For SQLite/libsql use `reliabilitySqliteTable('delivery')` and
`{ db, table, dialect: 'sqlite' }`; the native driver must support asynchronous
callback transactions. D1 uses that SQLite table and `{ db, table, driver: 'd1' }`.
Synchronous SQLite and MySQL are unsupported.

Export the table from the application's Drizzle schema and generate/apply its
migration with the application's existing migration tooling. Constructors do
not create or migrate tables. The schema has a composite primary key over
`tenantId`, `namespace`, `kind`, and `id`, plus indexes for due work and retention.
`reliabilityPgTable(name, schema)` supports an explicit PostgreSQL schema.

Every call requires a nonempty trusted tenant ID and namespace. Derive them from
admitted server context, not an unverified request field. They are included in
every lookup, unique identity and mutation predicate. Inbox identities also
include the configured consumer. A database initializer can set PostgreSQL RLS:
`onOpenTransaction(native, { tenantId })`. Standalone operations open a real
transaction when this initializer is configured. Keep the same initializer
function when composing native atomic commands.

Payload parsers receive `unknown` and may be asynchronous. They validate incoming
payloads and persisted JSON before delivery. Return bounded plain JSON that the
same parser can validate after persistence. Classes, cycles, undefined values,
nonfinite numbers, accessors and sparse arrays are rejected. The default JSON
limit is 64 KiB, configurable through `maxPayloadBytes` up to 1 MiB; nesting and
node counts are bounded too. Identifiers, deadlines, lease periods, errors and
batch sizes are validated. Store JSON is never cast into a payload type.

## Outbox admission and delivery

```ts
await outbox.enqueue(scope, {
  id: eventId, // Stable deduplication identity in this tenant namespace.
  payload: { type: 'entry.created', entryId },
  maxAttempts: 10,
});

const claims = await outbox.claimDue(scope, { limit: 20, leaseMs: 30_000 });
for (const claim of claims) {
  try {
    await destination.send(claim.payload, { idempotencyKey: claim.id });
  } catch {
    await outbox.retry(claim, { delayMs: 5_000, error: 'destination-unavailable' });
    continue;
  }
  // If acknowledgement fails, do not automatically invoke the destination again.
  await outbox.acknowledge(claim);
}
```

An identical admission returns the existing record. Reusing an ID with different
content raises `CONFLICT`. `availableAt` delays delivery; if supplied, it is part
of admission identity. Include topic/version information in your validated
payload envelope when needed.

`renew(claim, leaseMs)` extends an active lease. `retry(claim, { delayMs, error })`
releases it until its next deadline; exhausting `maxAttempts` marks it failed.
`fail(claim, errorCode)` records a terminal failure. A poll also marks an expired
final attempt failed. Error codes are bounded strings; arbitrary error objects
and stack traces are not persisted. `get(scope, id)` returns validated storage
metadata. No background timer, handler registry or automatic handler retry runs
inside the package: call `claimDue` from your scheduler or queue infrastructure.

Claims contain a generation, unique lease token, increasing fence, attempt and
expiry. All transitions check the current persisted identity, lease and fence.
Database time governs availability, lease validity and retention; worker clocks
cannot extend ownership. Processes can reopen stores and recover expired work
from durable rows. Generation changes after retention pruning prevent old
workers from completing a later use of the same ID.

## Share a business transaction

Use the same exact native Drizzle handle as the business adapter. Passing a
transaction from another handle or tenant fails. Every operation must be awaited.

```ts
import { crudTransaction } from '@velajs/crud';

await crudTransaction(entryAdapter, { tenantId: scope.tenantId }, async transaction => {
  await entryResource.execute('create', {
    transaction,
    vars: { tenantId: scope.tenantId },
    body: { id: entryId, title },
  });
  await outbox.enqueue(scope, {
    id: eventId,
    payload: { type: 'entry.created', entryId },
  }, { transaction });
});
```

Admission and business writes commit together. In-transaction payload validation, SQL or fencing errors
poison the transaction even when caught by the caller. Native operations accepted
but left pending are drained and cause rollback. Retained bound stores and
sessions expire. Deliver external effects after commit; they cannot be rolled
back by a database transaction.

Named database registrations use their own owner identity. Bind the native store
to that registration before joining its transaction:

```ts
import { withCrudTransactionStore } from '@velajs/crud';

const binding = registry.bindTransactionStore('main', store.transactionBinding);
// transaction belongs to a resource adapter resolved from this registration.
await withCrudTransactionStore(transaction, binding, { tenantId: scope.tenantId },
  async boundStore => {
    const boundOutbox = createOutbox({ store: boundStore, parsePayload });
    await boundOutbox.enqueue(scope, { id: eventId, payload });
  });
```

The native binding must match the registration's database. Do not use the
unwrapped native `store` with a registration-owned transaction. The bound feature
already uses the outer transaction and does not receive a second transaction
argument. The same pattern works for inbox and idempotency completion.

## Inbox completion

```ts
import { createInbox, fingerprint } from '@velajs/reliability';

const inbox = createInbox({ store, consumer: 'entry-projector', parsePayload });
const admitted = await inbox.claim(scope, {
  messageId,
  fingerprint: await fingerprint(payload),
  payload,
});
if (admitted.kind === 'claimed') {
  await crudTransaction(projectionAdapter, { tenantId: scope.tenantId }, async transaction => {
    await projectionResource.execute('create', {
      transaction,
      vars: { tenantId: scope.tenantId },
      body: project(admitted.claim.payload),
    });
    await inbox.complete(admitted.claim, { transaction });
  });
}
```

`completed` skips processing, `busy` reports the current retry deadline and
`conflict` indicates the same message identity has different content. A stale
completion rolls consumer database writes back, including when the fence error
is caught. Standalone completion is available for deduplication, but it cannot
make separately committed consumer writes atomic. Use the shared transaction for
that guarantee. Inbox consumer names are static configuration.

## Idempotency and bounded HTTP replay

```ts
import { createIdempotency } from '@velajs/reliability';
import {
  captureHttpResult, fingerprintRequest, parseHttpResult, replayHttpResult,
} from '@velajs/reliability/http';

const idempotency = createIdempotency({ store, parseResult: parseHttpResult });
const outcome = await idempotency.claim(scope, {
  key: idempotencyKey,
  fingerprint: await fingerprintRequest(request, {
    operation: 'create-entry', principal: admittedPrincipalId,
  }),
  leaseMs: 30_000,
  retentionMs: 86_400_000,
});
if (outcome.kind === 'completed') return replayHttpResult(outcome.value);
// Handle busy, conflict, failed, cancelled and expired without rerunning work.
if (outcome.kind !== 'claimed') return mapAdmissionOutcome(outcome);

const response = await createEntry();
let snapshot;
try {
  snapshot = await captureHttpResult(response);
} catch (error) {
  // The business action may already have committed. Do not retry it here.
  await idempotency.unavailable(outcome.claim);
  throw error;
}
await idempotency.complete(outcome.claim, snapshot);
return replayHttpResult(snapshot);
```

The snippet illustrates replay with a separately committed handler. A crash
between `createEntry` and completion still permits a later execution. For
database-only work, construct/validate the bounded snapshot and complete the
idempotency claim **inside the same business transaction**. This is the stronger
atomic path; it does not cover external effects. The package never automatically
retries a possibly committed handler.

`fingerprintRequest` hashes bounded request bytes, method, URL, selected headers,
and explicit operation/principal scope with Web Crypto. It reads a clone and
preserves the request. Select any additional headers affecting behavior. The
general `fingerprint(value)` helper hashes canonical bounded JSON.

`captureHttpResult` consumes the response body with a streaming byte limit,
without unbounded `arrayBuffer()`. Defaults are 32 KiB body, 8 KiB allowed headers,
and 32 headers. The hard body limit is 256 KiB. Increase `maxPayloadBytes` on the
idempotency feature when increasing HTTP limits; stored base64 also uses space.
The default replay headers are content-type, cache-control, etag and location.
Cookies, hop-by-hop headers and content-length are excluded. Capture before
content encoding; encoded bodies fail explicitly rather than replaying under
incorrect headers. Bodyless statuses and persisted headers/base64 are checked.

Oversized or unsupported responses raise `RESULT_UNAVAILABLE`. No truncation or
automatic rerun occurs. `unavailable(claim)` persists a terminal failure where
the lease is still valid. An expired lease cannot be overwritten to conceal a
new owner's work. A still-active attempt can be explicitly retried before completion; choose this
only when the application knows retry is safe. Terminal failures cannot be retried
with their old lease.

## One-off jobs

```ts
import { createScheduler } from '@velajs/reliability';
const jobs = createScheduler({ store, parsePayload: jobSchema.parse });
const job = await jobs.schedule(scope, {
  id: jobId, payload, dueAt: Date.now() + 60_000,
});
const edited = await jobs.reschedule(scope, {
  id: job.id, expectedGeneration: job.generation,
  expectedRevision: job.revision, dueAt: Date.now() + 120_000,
});
await jobs.cancel(scope, {
  id: edited.id, expectedGeneration: edited.generation,
  expectedRevision: edited.revision,
});
```

Generation plus revision prevent lost updates and stale edits after an ID is
pruned and reused. Cancel/reschedule invalidate any current lease. They cannot
undo an already running external effect. Only pending or leased jobs can be
edited; completed, failed and cancelled jobs are terminal. Rescheduling retains
the attempt budget. Poll with `claimDue` and use the same renew/complete/retry/fail
methods as outbox delivery. Recurring schedules are application policy.

## D1 boundary

D1 supports native standalone compare-and-set operations. It cannot join a
callback transaction. Only unconditional, precomputed outbox INSERT admission is
exposed for composition with existing atomic business inserts:

```ts
import { prepareOutboxInsert } from '@velajs/reliability/drizzle';
import { executeAtomicBatch, requireAtomicBatch } from '@velajs/crud';

const admission = await prepareOutboxInsert({
  db, table: deliveryTable, scope,
  input: { id: eventId, payload }, parsePayload,
  admission: 'unconditional',
});
await executeAtomicBatch(entryAdapter, [
  requireAtomicBatch(entryAdapter).create({ id: entryId, title }),
  admission,
], { tenantId: scope.tenantId });
```

All commands must use the exact same native handle and initializer. Values are
copied and commands authenticated before the native batch. Duplicate admission
fails the whole batch; unlike `enqueue`, an INSERT command does not turn a
duplicate into a successful no-op. Its immediate due time is precomputed as zero;
claim deadlines still use database time. Creation metadata uses preparation time.

Do not append this unconditional command to a conditional business mutation
whose scoped miss is allowed. Conditional admission is rejected by the preparer.
Fenced inbox/idempotency completion alongside business writes is unsupported on
D1 and fails before writes when requested through a transaction option. A
zero-row completion UPDATE is not a native rollback guard. Use a real
PostgreSQL/libsql transaction for those workflows. Existing atomic audit and
post-commit result-error semantics remain unchanged.

## Failure, retention and observability

Standalone claims and transitions use native conditional statements. A poll
validates all selected payloads before claiming any. A later SQL/network failure
can still leave a partial set of leases on an autocommit backend.
`ReliabilityClaimError` has `recoveryRequired: true` and the known acquired
`claims`; `committed` is true when a commit is known and otherwise undefined,
never a claim that the database rolled back. Unknown outcomes recover by lease
expiry. Handlers have not run inside this API. Explicit shared transactions roll
the entire poll back on error. `ReliabilityResultError` has `committed: true` when
a standalone mutation's returned row fails validation after commit. Native
atomic insert batches retain `AtomicBatchResultError` from the CRUD adapter.

Each feature exposes `prune(scope, limit)` for bounded removal of expired terminal
records; there is no automatic global deletion. Retention defaults to seven days,
starts on completion/failure/cancellation and is limited to one year. Completed
idempotency/inbox results beyond retention return `expired`, without starting new
work. Pruning permits later reuse of an ID with a new generation. Configure the
retention window to exceed the expected duplicate-delivery window.

An optional static `observer` accepts the structural interface
`onStart() -> { onEnd('success' | 'error' | 'cancelled') }`. It works with
`createExecutionTelemetryObserver({ telemetry, operation: 'outbox.delivery' })`
without importing Vela. Configure operation names statically and keep tenant,
payload and idempotency identities out of metric labels. Synchronous exceptions
and accidental rejected promises from observers cannot change execution results.
These callbacks measure feature operations; application handlers have their own
execution boundary.

`createMemoryReliabilityStore({ now? })` from `/testing` is a deterministic,
serialized reference adapter, not persistent production storage. Package tests
cover it, libsql and PGlite; root integration fixtures cover real PostgreSQL
connections, native D1, and the portable entrypoints in a native Worker.
