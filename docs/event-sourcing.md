# Domain history beside Vela live queries

Use `@velajs/event-source` when past business facts are part of the application's
model: inventory receipts/reservations, an order's transitions, replayable game
state, or historical metrics that cannot be derived from the current row alone.
Keep ordinary CRUD when current state is sufficient. Keep live queries for
synchronizing the current authorized result with clients.

## What each subsystem actually retains

| Subsystem | Retained data and replay | Ordering and subscribers |
| --- | --- | --- |
| `@velajs/vela/event-emitter` | Process-local callbacks; no history, reducers, or checkpoints. | Async dispatch with named/pattern listeners; errors propagate. |
| CRUD hooks | Before/after mutation hooks, persisted rows and shaped results. They do not create a durable event history or projection checkpoint. | Write lifecycle; the live bridge invalidates tags after a successful write. |
| Vela `CursorLog` | Bounded invalidation tags and an epoch. Resume determines whether to rerun a query or send a snapshot; it cannot reconstruct domain state. | Commit cursors start at 1; current cursor starts at 0. Live subscriptions belong to the engine and transport. |
| Cloudflare `DoCursorLog` | SQLite invalidation tags survive Durable Object hibernation; retention can discard old tags. It is not a domain journal. | Durable room log, monotonic SQLite cursor, epoch, tag-based resume verdict. |
| `@velajs/live-protocol` | Snapshot/delta wire formats and a codec for current query results. No append-only history or materializer store. | Ordered list operations; inserts have `before` anchors, updates replace whole rows. |
| `@velajs/event-source` | In-memory domain entries plus a persistence seam for validated projection checkpoints. Pure reducers reconstruct views from the retained source. | Entries start at 0; materializer watermark is exclusive-next; `EventSource` watermark is highest-consumed. Local disposer-based subscriptions, no network transport. |

The two delta formats share operation names but differ in behavior. Domain
`TableDiff` updates merge changed columns into existing keyed rows and ignore
missing rows. Live `RowOp` updates replace complete rows and can introduce an
absent row; ordered inserts need an anchor. A field-for-field bridge loses
semantics and can leak rows outside an authorized/filtered query. The migration
keeps table patches separate and leaves live wire encoding in `live-protocol`.

Likewise, replacing the tiny synchronous event-source emitter with the framework
emitter would add a framework dependency and change disposer, error, typing, and
dispatch semantics. Keeping a small local notifier preserves standalone Workers,
browser, and test usage. No dependency is added to Vela or live queries.

## Application integration

Own each domain stream and projection in an explicit tenant/environment scope.
Validate incoming commands, enforce authorization and business invariants, then
persist the domain events with a durable adapter or an atomic outbox. Advance the
projection only over committed history. After commit, call the application's
existing `LiveInvalidation` for the affected tag and room. Its live query reads
the projected view and the existing engine performs authorized result diffing.
Do not forward raw table diffs or domain sequence numbers as live frames/cursors.

A CRUD after-hook alone cannot promise atomic database-plus-event persistence:
if one write succeeds and the other fails, history and rows diverge. Use a storage
transaction/outbox where available; D1 callback transactions are unsupported.
The package deliberately includes no automatic CRUD or live bridge.

The shipped `EventLog` and `InMemorySnapshotStore` are volatile. The package does
not supply durable append storage, cross-process locking, command deduplication,
compaction, offline rebase, a database transaction, or a WebSocket server. An
application must choose those according to its persistence guarantees. Local
sequence deduplication handles repeated delivery from the same trusted stream;
a forged epoch or an event from another tenant is not made safe by its number.

## Concrete example

The [inventory application](../apps/event-sourcing-inventory/README.md) records
receiving 10, reserving 3, and receiving 5. It resumes available stock from a
checkpoint plus one new event, yielding 12. It then builds a new total-received
view from history, yielding 15. A live result of 12 and an invalidation-tag log
cannot recover that second answer. The same distinction matters for audit trails
and rebuilding a new projection after changing a read model.

See the [supported package API and migration notes](../packages/event-source/README.md)
for replay, checkpoint parsing, errors, limits, and subscription cleanup.

## Local notification delivery

The core `EventEmitter.emit(name, ...args)` retains its 1.x delivery policy:
exact handlers run concurrently, followed by matching wildcard groups. A rejected
group rejects the call and skips later groups. Use
`emitWithOptions(name, { settlement: 'complete' }, ...args)` to snapshot every
matching listener, attempt them all, and await completion. One failure is rethrown
unchanged; multiple failures become an `AggregateError` in registration order
(exact handlers before wildcard groups).

A `once` registration is consumed before its callback starts, including when the
callback throws, recursively emits, or overlaps another emission. `off` still
accepts the original callback, and a once callback may register its next delivery.
These are process-local notifications: successful completion does not persist an
event or provide an outbox.

## Scoped, validated events

Import `EventEmitterModule` and declare a shared vocabulary. A schema-bearing
`@OnEvent` decorator checks the listener's transformed payload type and opts into
`EventDispatcher` dispatch. It does not also subscribe to the string emitter.

```ts
import { Injectable, Module, Scope, VelaFactory } from '@velajs/vela';
import {
  EventDispatcher,
  EventEmitterModule,
  OnEvent,
  defineEventVocabulary,
  type EventPayload,
} from '@velajs/vela/events';
import { getRequestContainer } from '@velajs/vela/module-kit';
import { z } from 'zod';

const events = defineEventVocabulary({
  'account.created': z.object({ id: z.string().transform(Number) }),
});

@Injectable({ scope: Scope.REQUEST })
class AccountListener {
  @OnEvent(events['account.created'])
  async created(payload: EventPayload<typeof events['account.created']>) {
    // payload.id is a number; use an injected invocation-scoped service here.
  }
}

@Module({ imports: [EventEmitterModule], providers: [AccountListener] })
class AppModule {}

const app = await VelaFactory.create(AppModule);
await app.get(EventDispatcher).emit(events['account.created'], { id: '42' });
```

`defineEvent(name, schema)` declares a single event. Standard Schema input and
output types remain separate, and asynchronous validation runs once per dispatch.
`defineEventVocabulary` preserves exact property names; share the same schema
objects across producers/listeners. Conflicting schemas for the same dispatched
name reject before listener effects. Every matching listener is attempted and
settled; one failure is rethrown unchanged, multiple failures are aggregated.
Invalid input rejects before listener construction, even when no listener exists.

`EventDispatcher.emit` owns a fresh managed invocation. It does not inherit an
HTTP request or authenticated tenant from its caller. To react inside a current
invocation, bind explicitly:

```ts
const scoped = app.get(EventDispatcher).inScope(getRequestContainer(context));
await scoped.emit(events['account.created'], { id: '42' });
await scoped.emitUnknown(events['account.created'], externalValue);
scoped.defer(events['account.created'], { id: '43' });
```

The HTTP adapter owns that scope's completion. Outside HTTP, use
`createExecutionScope(app.getContainer())`, bind its `container`, and await
`finish()` after work completes. Closed, unmanaged, or foreign application scopes
are rejected. `defer` queues validation and dispatch for managed completion;
listener dependencies stay alive until delivery settles, and failures reject the
completion promise. Await immediate `emit` calls before finishing their scope.
Payload objects supplied to `defer` must not be mutated before completion.

Existing `@OnEvent('name')` methods keep the `EventEmitter` path. Singleton and
transient providers keep their application subscription instance; request-scoped
providers, including consumers of request dependencies, now resolve in a fresh
managed invocation for each listener delivery. These independent invocations do
not copy HTTP authority. Every listener is resolved from its declaring module,
including duplicate class tokens in keyed modules. For several listeners sharing
one existing tenant/request context, use schema definitions with `inScope`.

Deferred notifications and CRUD `afterCommit` remain best-effort invocation work.
They provide no durable outbox, atomic database-plus-event write, or cross-worker
delivery. Keep durable adapters and pure replay reducers separate from local
listener side effects; `@velajs/event-source` remains independent of the core DI
and dispatcher APIs.
