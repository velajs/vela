/**
 * Sequence-number vocabulary for the event-sourcing runtime.
 *
 * Three flavours exist so the same log can serve a server-authoritative
 * timeline and a future offline-optimistic client without changing the
 * on-the-wire shape:
 *
 * - {@link GlobalSeq} — the confirmed, monotonic index the log assigns.
 * - {@link ClientSeq} — a composite counter that survives rebasing local
 *   edits onto a newer server baseline (no rebase engine ships here yet, but
 *   the field is reserved so persisted client seqs stay forward-compatible).
 * - {@link InputEvent} — a not-yet-sequenced event; the log stamps a
 *   {@link GlobalSeq} onto it at append time.
 *
 * @module
 */

/**
 * A confirmed, server-authoritative position in the log.
 *
 * Assigned by {@link EventLog} on append and never reused within one epoch. Every stored entry
 * carries one; consumers use it as their catch-up watermark.
 */
export type GlobalSeq = number;

/**
 * A client-originated position designed to outlive a rebase.
 *
 * `client` counts the client's own edits, `global` pins the last confirmed
 * {@link GlobalSeq} the client had seen, and `rebaseGeneration` bumps every
 * time the client's pending edits are replayed onto a fresher server baseline.
 * Nothing here consumes `rebaseGeneration` today — it is reserved so seqs
 * written to disk now keep meaning once an offline rebase engine lands.
 */
export interface ClientSeq {
  /** Monotonic counter over the client's own optimistic edits. */
  readonly client: number;
  /** Last confirmed {@link GlobalSeq} this client had observed (0 when none). */
  readonly global: number;
  /** Bumped on each rebase of pending edits onto a new baseline. */
  readonly rebaseGeneration: number;
}

/** Either flavour of a positioned event. */
export type Seq = GlobalSeq | ClientSeq;

/**
 * An event that has not been positioned in the log yet.
 *
 * Produced by {@link defineEvents} factories (and by hand) as an optimistic
 * command payload. It carries the discriminating `type`, a typed `payload`,
 * and a creation `timestamp`, but no seq — {@link EventLog.append} assigns one.
 */
export interface InputEvent<Type extends string = string, Payload = unknown> {
  /** Event-type discriminator, e.g. `"chat.messageSent"`. */
  readonly type: Type;
  /** JSON-serialisable payload for this event. */
  readonly payload: Payload;
  /** Epoch milliseconds when the event was created. */
  readonly timestamp: number;
}

/** Narrow a {@link Seq} to a confirmed {@link GlobalSeq}. */
export const isGlobalSeq = (seq: unknown): seq is GlobalSeq =>
  typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0;

/** Narrow a {@link Seq} to a {@link ClientSeq}. */
export const isClientSeq = (seq: unknown): seq is ClientSeq =>
  typeof seq === 'object' &&
  seq !== null &&
  'client' in seq &&
  isGlobalSeq(seq.client) &&
  'global' in seq &&
  isGlobalSeq(seq.global) &&
  'rebaseGeneration' in seq &&
  isGlobalSeq(seq.rebaseGeneration);

/** Structural guard for {@link InputEvent}. */
export const isInputEvent = (value: unknown): value is InputEvent =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  typeof value.type === 'string' &&
  value.type.length > 0 &&
  'payload' in value &&
  'timestamp' in value &&
  typeof value.timestamp === 'number' &&
  Number.isFinite(value.timestamp);
