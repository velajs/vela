/**
 * The row-level delta unit shared between the log and any consumer that keeps
 * a keyed projection of a table.
 *
 * ## Different from `@velajs/live-protocol`
 *
 * Table updates patch columns of an existing keyed row; absent updates are
 * ignored. Live RowOps replace full rows in an ordered query result and use
 * `before` anchors. They are not interchangeable. Materialize a table patch,
 * then let the live engine re-query and encode the resulting authorized view.
 *
 * @module
 */

/**
 * One keyed change to a table row.
 *
 * `op` names the mutation, `key` is the row's primary key, and `row` carries
 * the new column values. A `delete` needs only the key.
 */
export type RowChange =
  | { readonly op: 'insert'; readonly key: string; readonly row: Record<string, unknown> }
  | { readonly op: 'update'; readonly key: string; readonly row: Record<string, unknown> }
  | { readonly op: 'delete'; readonly key: string };

/**
 * An ordered batch of row changes scoped to a single named table, stamped with
 * the moment it was produced.
 */
export interface TableDiff {
  /** Logical table name (matches the projection this diff feeds). */
  readonly table: string;
  /** Row changes in application order (earliest first). */
  readonly changes: readonly RowChange[];
  /** Epoch milliseconds when the diff was emitted. */
  readonly timestamp: number;
}

/** Build a {@link TableDiff}, defaulting the timestamp to now. */
export const createTableDiff = (
  table: string,
  changes: readonly RowChange[],
  timestamp: number = Date.now(),
): TableDiff => ({ table, changes, timestamp });

/** `true` when the diff carries no changes. */
export const isDiffEmpty = (diff: TableDiff): boolean => diff.changes.length === 0;

/** Number of row changes the diff carries. */
export const diffSize = (diff: TableDiff): number => diff.changes.length;

/** Split a diff's changes into the three operation buckets. */
export const partitionChanges = (
  diff: TableDiff,
): { inserts: RowChange[]; updates: RowChange[]; deletes: RowChange[] } => {
  const inserts: RowChange[] = [];
  const updates: RowChange[] = [];
  const deletes: RowChange[] = [];
  for (const change of diff.changes) {
    if (change.op === 'insert') inserts.push(change);
    else if (change.op === 'update') updates.push(change);
    else deletes.push(change);
  }
  return { inserts, updates, deletes };
};

/**
 * Concatenate several same-table diffs into one, preserving change order and
 * carrying the latest timestamp. Returns `null` when given nothing to merge.
 */
export const mergeDiffs = (diffs: readonly TableDiff[]): TableDiff | null => {
  const first = diffs[0];
  if (first === undefined) return null;
  if (diffs.some((diff) => diff.table !== first.table)) {
    throw new TypeError('Cannot merge diffs from different tables.');
  }
  const last = diffs[diffs.length - 1] ?? first;
  return createTableDiff(
    first.table,
    diffs.flatMap((diff) => diff.changes),
    last.timestamp,
  );
};
