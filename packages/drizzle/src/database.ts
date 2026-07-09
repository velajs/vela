/**
 * The minimal structural surface this adapter needs from a Drizzle database.
 *
 * Drizzle's dialect-generic types are deliberately NOT threaded through here:
 * a single laundering boundary (this file) keeps the adapter source strictly
 * typed while accepting any of the three dialect clients (sqlite/pg/mysql) —
 * the exact pattern hono-crud's drizzle package used (`helpers.ts cast()`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type DrizzleDialect = 'sqlite' | 'pg' | 'mysql';

/** A Drizzle table object (dialect-specific classes share this shape). */
export type DrizzleTable = Record<string, unknown>;

/** A Drizzle column, as returned by `getTableColumns(table)[name]`. */
export type DrizzleColumn = any;

/** SQL fragment / condition produced by drizzle operators. */
export type DrizzleSql = any;

/** The query-builder surface shared by db handles AND transaction handles. */
export interface DrizzleDatabase {
  select(fields?: any): any;
  insert(table: any): any;
  update(table: any): any;
  delete(table: any): any;
  transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

/** Launder an opaque scope.tx / db into the structural surface. */
export function asDatabase(handle: unknown): DrizzleDatabase {
  return handle as DrizzleDatabase;
}
