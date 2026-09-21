/**
 * `@velajs/event-source` — a zero-dependency, platform-neutral event-sourcing
 * runtime.
 *
 * - {@link EventLog} — append-only log with auto-parenting, causal batch commit,
 *   and seq-watermark catch-up.
 * - {@link EventSource} — reducer-driven state over a source log, with a
 *   dual-log watermark, configurable unknown-event handling, and an
 *   async-iterator event stream.
 * - {@link defineEvents} / {@link defineMaterializer} — typed DSLs for events
 *   and durable projections, over a pluggable {@link SnapshotStore}.
 * - {@link TableDiff} + {@link applyDiff} — the row-level delta unit and its
 *   pure appliers.
 *
 * Everything here is idempotency-sensitive: read the at-least-once notes on
 * {@link EventSource} and {@link MaterializerRuntime}.
 *
 * @module
 */

// Seq vocabulary
export type { ClientSeq, GlobalSeq, InputEvent, Seq } from './seq';
export { isClientSeq, isGlobalSeq, isInputEvent } from './seq';

// Table diffs + pure appliers
export type { RowChange, TableDiff } from './table-diff';
export { createTableDiff, diffSize, isDiffEmpty, mergeDiffs, partitionChanges } from './table-diff';
export type { RowMap, TableSnapshot } from './apply-diff';
export { applyDiff, applyDiffs, applyDiffToSnapshot } from './apply-diff';

// Event emitter
export type { Listener, WildcardListener } from './event-emitter';
export { EventEmitter } from './event-emitter';

// Event log
export type { AppendableEvent, AppendOptions, EventLogEntry, EventLogSnapshot } from './event-log';
export { EventLog } from './event-log';

// Event source runtime
export type {
  EventReducer,
  EventSourceEvents,
  EventSourceOptions,
  UnknownEventHandling,
} from './event-source';
export { EventSource } from './event-source';

// Subscriptions
export type { EventCallback, StateChangeCallback } from './subscription';
export { SubscriptionManager } from './subscription';

// Snapshot store
export type { SnapshotStore } from './snapshot-store';
export { InMemorySnapshotStore } from './snapshot-store';

// Typed events DSL
export type {
  EventFactory,
  EventNamespace,
  EventPayloadMap,
  EventsDefinition,
  InferPayload,
  PayloadType,
  SchemaLike,
} from './define-events';
export { defineEvents, payload } from './define-events';

// Materializer DSL + runtime
export type {
  EntrySource,
  EntrySourceCheckpoint,
  Materializer,
  MaterializerDef,
  MaterializerReducer,
  MaterializerRuntimeOptions,
} from './define-materializer';
export { defineMaterializer, MaterializerRuntime } from './define-materializer';
