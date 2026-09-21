# @velajs/event-source

Optional, zero-dependency domain event sourcing for Vela and other Web API
runtimes. Keep the business events behind a state model, rebuild a new projection
from history, and resume existing projections from validated checkpoints.
The package imports neither Vela, Node, nor Cloudflare. It uses `structuredClone`,
Web Crypto, `AbortSignal`, and async iterators.

```sh
pnpm add @velajs/event-source
```

The [inventory example](../../apps/event-sourcing-inventory/README.md) runs locally
and demonstrates checkpoint recovery and a new historical projection. Read the
[architecture comparison](../../docs/event-sourcing.md) before choosing this over
ordinary CRUD or live queries.

## A log and a projection

```ts
import {
  EventLog, defineEvents, payload, defineMaterializer,
  MaterializerRuntime, InMemorySnapshotStore,
} from '@velajs/event-source';

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Invalid count');
  }
  return value;
}

const events = defineEvents({ stock: { received: payload<number>() } });
const log = new EventLog();
const received = defineMaterializer({
  name: 'received-v1',
  initial: () => 0,
  parseSnapshot: count,
  handle: (state, entry) => entry.type === events.stock.received.type
    ? state + count(entry.payload) : state,
});
const runtime = new MaterializerRuntime([received], {
  snapshotStore: new InMemorySnapshotStore(),
  snapshotKey: 'tenant-a/received/v1',
});
log.append(events.stock.received(count(10)));
runtime.catchUp(log); // 1 entry; received.state === 10
await runtime.persistSnapshots();
```

Create separate logs, materializers, runtimes, and storage namespaces for each
application/environment/tenant stream. There is no global state or framework
registration. Do not put tenant data in a module-level singleton shared across
requests. Give one owner serialized access to a runtime; await recovery before
applying events. A Durable Object is a suitable owner, but no storage adapter is
included here.

## Supported exports

All exports are on `@velajs/event-source`; there are no public subpaths.

| API | Contract |
| --- | --- |
| `EventLog` | In-memory append-only history; `append`, `appendChecked`, atomic `commitAll`, `getSince`, bounded `getFrom`, finite `events`, `snapshot`, `load`, `clear`, `getCheckpoint`. |
| `EventSource` | One reducer-driven state, `applyEvent`, incremental `replayFrom`, `reset`, current `state`, `sourceWatermark`, `sourceEpoch`, `replayed`, applied `log`, local `emitter`, streaming `events`. |
| `defineMaterializer`, `MaterializerRuntime` | Named views; `applyEntries`, bounded `catchUp`, `recoverFromSnapshots`, `persistSnapshots`, `bootstrap`, `reset`, and exclusive-next-position `appliedSeq`. |
| `SnapshotStore`, `InMemorySnapshotStore` | Async `save`/`load`/`list`/`delete`/`clear`; one atomic value contains every view and its watermark. The supplied store is volatile and clones values. |
| `defineEvents`, `payload` | Typed namespaced factories and `.type` literals. A Standard Schema leaf supplies its output type only: **factories do not execute validators**. Parse external commands before constructing events; reducers still receive `unknown` payloads. `_types` is type-only. |
| `EventEmitter` | Synchronous typed local signals; `on`/`once`/`onAny` return disposers; `off`/`offAny`, `clear`, `hasListeners`, `listenerCount`. Subscriber throws are isolated. |
| `SubscriptionManager` | Optional local fan-out: `onStateChange`/`onEvent` return disposers, `notifyState`/`notifyEvent`, `clear`, `size`. No transport, auth, or persistence. |
| `createTableDiff`, `isDiffEmpty`, `diffSize`, `partitionChanges`, `mergeDiffs` | Keyed, unordered table patches; merge only same-table diffs in input order. |
| `applyDiff`, `applyDiffs`, `applyDiffToSnapshot` | Copy-on-write maps. Insert replaces, update patches an existing row, delete removes. Missing updates/deletes are ignored. |
| `isGlobalSeq`, `isClientSeq`, `isInputEvent` | Structural guards accepting `unknown`; safe non-negative integer sequences and finite numeric timestamps. Payload schemas remain the application's responsibility. |

Public types include `EventLogEntry`, `EventLogSnapshot`, `AppendableEvent`,
`AppendOptions`, `GlobalSeq`, `ClientSeq`, `Seq`, `InputEvent`, `EventReducer`,
`EventSourceOptions`, `EventSourceEvents`, `UnknownEventHandling`, `EntrySource`,
`EntrySourceCheckpoint`, `Materializer`, `MaterializerDef`, `MaterializerReducer`,
`MaterializerRuntimeOptions`, `RowChange`, `TableDiff`, `RowMap`, `TableSnapshot`,
`Listener`, `WildcardListener`, `EventCallback`, `StateChangeCallback`, and the
event DSL types `EventFactory`, `EventNamespace`, `EventPayloadMap`,
`EventsDefinition`, `InferPayload`, `PayloadType`, `SchemaLike`.

## History, validation, and sequences

`EventLog` assigns contiguous positions starting at **0**. `head` is the last
entry or `null`; `nextSeq` is the exclusive upper bound. `getSince(n)` includes
`n`; `getFrom(n, limit)` accepts 1–1,000 entries. `events(n)` reads the currently
available history and finishes. `clear()` starts a new epoch and resets positions.
Sequence numbers have meaning only within that epoch, and are unrelated to live
commit cursors. `ClientSeq` is causal metadata; it provides no offline rebase engine
or command deduplication. `parentSeq` defaults to the preceding log entry.

Payloads and table rows must contain finite JSON primitives, arrays, and plain
objects. A missing top-level payload is allowed. Maps, dates, bigints, cycles, and
nested `undefined` are rejected. Entries, including causal metadata, are detached
and deeply frozen. Invalid appends or batches leave the log unchanged.
`appendChecked(event, check)` commits only if a synchronous check returns normally;
it does not roll back external side effects. Reentrant writes from a check fail.

`load(unknown)` validates the version-2 log envelope, contiguous entries, metadata,
and table diffs before replacing history. It does not authenticate the producer
or validate your business payload schema. Retain a trusted, durable event source;
loading a caller-supplied epoch is not authorization.

## Replay and failures

Reducers must be pure, deterministic, and return a new state for a handled event.
Returning the same reference means unhandled, including a known no-op. The default
`unknownEventHandling: 'fail'` stops there; choose `'ignore'`, `'warn'`, or a callback
that claims known no-ops. State must support `structuredClone`. Treat exposed state
as read-only, including nested values.

A failed reducer leaves that entry pending and rolls back in-memory state.
Earlier successful entries in a batch remain applied. `MaterializerRuntime`
rolls back **all** views for the failed entry. Positions below its watermark are
skipped; future positions with a gap fail. It does not buffer out-of-order events.
Retry the missing/failed position, then continue in source order. Direct
`applyEntries` assumes an authenticated, ordered, single-stream feed; it cannot
identify the lineage of individual entries. Bind checkpointed projections with
`catchUp(source)`; an unbound direct-delivery watermark is rebuilt on first binding.
Do not feed entries from another log into a bound runtime.

`catchUp` reads one epoch/head boundary in pages (default 500, max 1,000), with a
10,000-entry default backlog cap. Configure `catchUpPageSize` and
`maxCatchUpEntries` for your workload. An epoch change or rewound head rebuilds
from `initial()`. Retained history must cover the full rebuild: this package does
not compact logs or synthesize missing domain events. `EntrySource` is synchronous;
asynchronous storage adapters must prepare a bounded local source first.

A restart may repeat events after the last checkpoint. A counter reducer is safe:
it restores the older state, then recomputes the missing tail. Sending an email
inside that reducer is not safe. Use an outbox or an external idempotency key for
side effects. Repeated **commands** appended twice are distinct events; transport
command deduplication and optimistic concurrency belong to the durable writer.

## Checkpoint recovery

`persistSnapshots()` saves one version-2 bundle containing every materializer's
state, source epoch, and exclusive-next watermark. Saves on the same runtime are
ordered; failed saves reject and may be retried. The store must atomically replace
the entire value. Separate runtimes must not share a writable checkpoint key.

`bootstrap(source)` restores, then catches up. Each materializer's
`parseSnapshot(unknown)` validates its state before it becomes a domain value.
Custom `Materializer` implementations must also implement `restoreState(unknown)`
with validation; `setState(S)` is reserved for already typed state and rollback.
Missing, malformed, mismatched, or rejected checkpoints reset **all** views and
replay; missing parsers also force a rebuild. Change the materializer name or
`snapshotKey` when changing a reducer's interpretation of history. A valid shape
alone cannot detect stale business logic. Preserve the log independently of
projection checkpoints; neither in-memory class provides durable commits.

## One-state runtime and subscriptions

```ts
const saved = {
  state: structuredClone(source.state),
  seq: source.sourceWatermark,
  epoch: source.sourceEpoch,
};
// Validate persisted state with your application schema before passing it here.
source.reset(saved.state, saved.seq, saved.epoch);
source.replayFrom(domainLog);
```

`EventSource` keeps its own applied-entry log; its local positions may differ from
the source positions after checkpoint resume or local writes. Reducers see source
entries during replay; subscription notifications and `events()` contain local
applied entries. `sourceWatermark` is the highest consumed source position, starting
at **-1**. Resuming at a non-negative watermark requires its original `sourceEpoch`.
A changed/rewound source throws until explicitly reset. `reset` clears local history
and ends old iterators. Inspect `source.log`; write through the runtime.

The emitter provides `ready` (first successful replay after reset), `replay-error`,
`state-changed`, `event-applied` (including ignored events), and `reset`.
Subscriber exceptions cannot undo a committed event; source watermarks advance
before notification. Reentrant runtime mutation during reduction/notification is
rejected; schedule follow-up commands after the current call completes.

`for await (const entry of source.events(signal))` drains local history, then
waits for commits without duplicating entries arriving during the drain. Break the
loop to clean up listeners; use `AbortSignal` to cancel an outstanding `next()`.
An idle iterator cannot be interrupted by queuing `return()` alone.

## Migrating the standalone 0.1.0 checkout

The monorepo preserves all previous root exports and the MIT license. The npm
registry returned 404 for this package on 2026-09-21; `1.0.0` is the monorepo
baseline, and the pending root Changeset prepares the next 1.x release. The existing
CLI release plan remains independent. The former changelog is retained.

Intentional changes:

- `EventSource.reset(state, seq, epoch)` requires the epoch when `seq >= 0`, clears
  applied history, and ends existing iterators. Old state/seq-only checkpoints
  must be rebuilt from trusted history.
- Add `parseSnapshot` to persisted materializers. Unvalidated legacy projection
  states rebuild safely. Version-2 logs and valid version-2 bundles remain usable;
  per-materializer legacy checkpoints rebuild.
- Non-JSON events, invalid sequences/metadata, ambiguous dotted factory names,
  the reserved `_types` namespace, and mixed-table merges now fail explicitly.
- `commitAll` validates atomically; `EventSource` rolls back mutating failures,
  rejects lineage mixing and reentrant writes, emits `ready` once per reset, and
  streams all committed events (including ignored ones) with local positions.
- The small typed emitter remains independent because the Vela framework emitter
  has asynchronous dispatch, different wildcard/error semantics, and DI concerns.
  Use Vela's emitter for application lifecycle events; this one for local runtime
  notifications. Table patches are **not** live wire frames.

Source history: migrated from `velajs/event-source` at
`fa13b7087b1e132b8b997baf7e58bec721365e0b`. The original checkout is preserved;
release ownership, workspace configuration, catalog, and lockfile now belong to
`velajs/vela`. No local release workflows or generated outputs are imported.
