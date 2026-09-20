/**
 * The shared keyed list-delta codec — BOTH sides of the wire implement the
 * delta contract through this one module: the server encodes a previous-vs-next
 * query result into `RowOp`s ({@link encodeListDelta}), the client merges them
 * into its cached value ({@link applyListDelta}).
 *
 * Ported from lunora's `subscription-delivery.ts` (encoder) and
 * `delta-merge.ts` (merge), with two deliberate changes:
 *
 * 1. The key field defaults to `'id'` (Vela/CRUD convention, not lunora's
 *    `_id`) and is configurable per query.
 * 2. `insert` ops carry an explicit `before` anchor (the key of the row they
 *    precede in the authoritative result; `null` = append) instead of
 *    approximating position via a `_creationTime` heuristic. Because encoder
 *    and merge live in the same package, this buys the exact-reconstruction
 *    property the conformance suite enforces: whenever the encoder does not
 *    bail, `applyListDelta(previous, encodeListDelta(previous, next))` is
 *    deep-equal to `next`, ordering included.
 *
 * Bail-to-snapshot contract (identical on both sides — the server MUST send a
 * full `data` snapshot and the client MUST fall back to full replacement when
 * any of these hold):
 *
 * 1. previous or next is not an array;
 * 2. any row is not a plain object carrying a string key (or the value cannot
 *    be JSON-serialized);
 * 3. a duplicate key appears in either array;
 * 4. rows present in BOTH arrays changed relative order (the merge replaces
 *    survivors in place and never reorders them).
 *
 * These are correctness conditions only. The codec deliberately does not use
 * operation count as a cost heuristic: callers that can send either encoding
 * must compare the completed delta and snapshot wire frames instead.
 *
 * Op ordering inside a delta: deletes first (previous order), then
 * inserts/updates (next order) — the merge never sees a transient over-length
 * list. Merging is idempotent (`insert` on an existing key replaces in place,
 * `delete` of an absent key is a no-op) so at-least-once replay after a
 * reconnect is harmless.
 */

import type { RowOp } from './frames';

/** Default row-identity field. Per-query override rides the `sub` frame's `key`. */
export const DEFAULT_KEY_FIELD = 'id';

type Row = Record<string, unknown>;

type RowIndex = Map<string, Row>;

const isPlainObject = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readRowKey = (row: Row, keyField: string): string | undefined => {
  const key = row[keyField];
  return typeof key === 'string' ? key : undefined;
};

/**
 * Index rows by key preserving order; `undefined` the moment any row is
 * unkeyable or a key repeats (bail rules 2 and 3 — a duplicated key cannot be
 * expressed as keyed deltas without silently collapsing rows).
 */
const indexRows = (rows: unknown[], keyField: string): RowIndex | undefined => {
  const byKey = new Map<string, Row>();
  for (const row of rows) {
    if (!isPlainObject(row)) return undefined;
    const key = readRowKey(row, keyField);
    if (key === undefined || byKey.has(key)) return undefined;
    byKey.set(key, row);
  }
  return byKey;
};

/**
 * True when rows present in BOTH lists keep the same relative order (bail
 * rule 4): the merge updates survivors in place and never reorders them, so a
 * survivor that moved cannot be expressed as deltas.
 */
const survivorsKeepOrder = (previous: RowIndex, next: RowIndex): boolean => {
  const survivingPrevious = [...previous.keys()].filter((key) => next.has(key));
  const survivingNext = [...next.keys()].filter((key) => previous.has(key));
  if (survivingPrevious.length !== survivingNext.length) return false;
  return survivingPrevious.every((key, index) => survivingNext[index] === key);
};

/**
 * Diff `previous` vs `next` into row ops, or `undefined` when any correctness
 * bail rule holds and the caller must send a full snapshot instead. Whether a
 * valid delta is cheaper than that snapshot is a delivery-layer decision.
 *
 * An empty array is a valid result (no row-level change — typically the server
 * catches byte-identical results earlier and sends `settled` instead).
 */
export const encodeListDelta = (
  previous: unknown,
  next: unknown,
  keyField: string = DEFAULT_KEY_FIELD,
): RowOp[] | undefined => {
  try {
    if (!Array.isArray(previous) || !Array.isArray(next)) return undefined;

    const previousIndex = indexRows(previous, keyField);
    const nextIndex = indexRows(next, keyField);
    if (previousIndex === undefined || nextIndex === undefined) return undefined;
    if (!survivorsKeepOrder(previousIndex, nextIndex)) return undefined;

    const ops: RowOp[] = [];

    // Deletes first, in previous order.
    for (const key of previousIndex.keys()) {
      if (!nextIndex.has(key)) ops.push({ op: 'delete', key });
    }

    // The `before` anchor for an insert at position i is the nearest FOLLOWING
    // survivor in next order (null = append). At merge time, when the insert
    // applies, the list holds exactly the survivors (in order, updates replace
    // in place) plus earlier inserts; splicing sequentially before the anchor
    // therefore reproduces next's ordering exactly — inserts sharing an anchor
    // stack in emission order, trailing inserts append in emission order.
    const followingSurvivor = new Map<string, string | null>();
    let anchor: string | null = null;
    for (const key of [...nextIndex.keys()].toReversed()) {
      followingSurvivor.set(key, anchor);
      if (previousIndex.has(key)) anchor = key;
    }

    // Inserts/updates in next order. Each row is fingerprinted with a single
    // JSON.stringify reused for the changed-row compare; an unserializable row
    // throws and the whole encode bails to snapshot (rule 2).
    for (const [key, nextRow] of nextIndex) {
      const previousRow = previousIndex.get(key);
      const nextFingerprint = JSON.stringify(nextRow);
      if (previousRow === undefined) {
        ops.push({ op: 'insert', key, row: nextRow, before: followingSurvivor.get(key) ?? null });
        continue;
      }
      if (JSON.stringify(previousRow) !== nextFingerprint) {
        ops.push({ op: 'update', key, row: nextRow });
      }
    }

    return ops;
  } catch {
    return undefined;
  }
};

/**
 * Merge row ops into a cached array result, returning a NEW array (the input
 * is never mutated), or `undefined` when the ops cannot be applied cleanly —
 * the caller then falls back to full replacement and lets the next snapshot
 * reconcile.
 *
 * Idempotent by construction: replaying an op after a snapshot already
 * delivered its effect changes nothing.
 */
export const applyListDelta = (
  current: unknown,
  ops: readonly RowOp[],
  keyField: string = DEFAULT_KEY_FIELD,
): unknown[] | undefined => {
  if (!Array.isArray(current)) return undefined;

  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const element of current) {
    if (!isPlainObject(element)) return undefined;
    const key = readRowKey(element, keyField);
    if (key === undefined || seen.has(key)) return undefined;
    seen.add(key);
    rows.push(element);
  }

  const next = [...rows];
  for (const op of ops) {
    const existingIndex = next.findIndex((row) => row[keyField] === op.key);

    switch (op.op) {
      case 'delete':
        if (existingIndex !== -1) next.splice(existingIndex, 1);
        continue;
      case 'insert':
      case 'update':
        if (existingIndex !== -1) {
          // Present → replace in place. Covers `update`, and an `insert` whose
          // row a snapshot already delivered (replay idempotency).
          next[existingIndex] = op.row;
          continue;
        }

        if (op.op === 'insert' && op.before !== null) {
          const anchorIndex = next.findIndex((row) => row[keyField] === op.before);
          if (anchorIndex !== -1) {
            next.splice(anchorIndex, 0, op.row);
            continue;
          }
        }

        // `insert` with a null/missing anchor, or an `update` for a row this page
        // never held (degraded replay) → append.
        next.push(op.row);
        continue;
      default: {
        const unexpected: never = op;
        throw new TypeError(`Unknown live row operation: ${JSON.stringify(unexpected)}`);
      }
    }
  }

  return next;
};
