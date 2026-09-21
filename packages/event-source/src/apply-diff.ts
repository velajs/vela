/**
 * Pure reducers that fold {@link TableDiff}s into keyed row maps.
 *
 * Every helper is side-effect free and copy-on-write: the input map is never
 * mutated, so callers decide when to swap their reference. Application is
 * idempotent by construction — an `insert` of an existing key replaces it in
 * place, and a `delete`/`update` of an absent key is a no-op — safe for immediate
 * duplicate application. Older patches arriving after newer ones can still
 * overwrite newer data; enforce source ordering and watermarks before applying.
 *
 * @module
 */

import type { RowChange, TableDiff } from './table-diff';

/** A keyed set of rows for one table: primary key → column values. */
export type RowMap = ReadonlyMap<string, Record<string, unknown>>;

const applyChange = (target: Map<string, Record<string, unknown>>, change: RowChange): void => {
  switch (change.op) {
    case 'insert': {
      // Replace-in-place on a key collision keeps re-delivery idempotent.
      target.set(change.key, { ...change.row });
      return;
    }
    case 'update': {
      const current = target.get(change.key);
      // Patch onto the existing row; skip when the row is gone (a delete raced
      // ahead of this update), rather than resurrecting a partial row.
      if (current !== undefined) target.set(change.key, { ...current, ...change.row });
      return;
    }
    case 'delete': {
      target.delete(change.key);
    }
  }
};

/**
 * Apply one {@link TableDiff} to a row map, returning a fresh map. The input is
 * left untouched.
 */
export const applyDiff = (
  current: RowMap,
  diff: TableDiff,
): Map<string, Record<string, unknown>> => {
  const next = new Map(current);
  for (const change of diff.changes) applyChange(next, change);
  return next;
};

/**
 * Apply an ordered list of diffs to a row map in a single pass, copying once
 * rather than per diff.
 */
export const applyDiffs = (
  current: RowMap,
  diffs: readonly TableDiff[],
): Map<string, Record<string, unknown>> => {
  const next = new Map(current);
  for (const diff of diffs) {
    for (const change of diff.changes) applyChange(next, change);
  }
  return next;
};

/** A multi-table snapshot: table name → its row map. */
export type TableSnapshot = ReadonlyMap<string, RowMap>;

/**
 * Merge a {@link TableDiff} into a multi-table snapshot, returning a fully
 * mutable copy of the table structure. Each table gets its own fresh row map;
 * the row objects themselves are shared by reference (shallow copy), so
 * untouched rows are never cloned.
 */
export const applyDiffToSnapshot = (
  snapshot: TableSnapshot,
  diff: TableDiff,
): Map<string, Map<string, Record<string, unknown>>> => {
  const next = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [table, rows] of snapshot) next.set(table, new Map(rows));
  const rows = next.get(diff.table) ?? new Map<string, Record<string, unknown>>();
  next.set(diff.table, applyDiff(rows, diff));
  return next;
};
