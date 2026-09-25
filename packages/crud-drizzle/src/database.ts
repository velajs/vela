/**
 * Explicit reflection boundary for Drizzle's dialect-specific fluent builders.
 * Only this module erases builder generics: Drizzle dynamically changes the
 * builder type after each call, and its sqlite/pg/mysql clients have incompatible
 * overloads. Rows stay records here; callers must decode before claiming a
 * narrower row type. SQL and columns retain the upstream types.
 */
import type { AnyColumn, SQL, SQLWrapper, Table } from 'drizzle-orm';
import type { AdapterScope } from '@velajs/crud/adapter';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type {
  MySqlDatabase,
  MySqlQueryResultHKT,
  PreparedQueryHKTBase,
} from 'drizzle-orm/mysql-core';

export type DrizzleDialect = 'sqlite' | 'pg' | 'mysql';
export type DrizzleTable = Table;
export type DrizzleColumn = AnyColumn;
export type DrizzleSql = SQLWrapper;
type Row = Record<string, unknown>;

interface SelectBuilder extends PromiseLike<Row[]> {
  from(table: Table | SQLWrapper): SelectBuilder;
  where(condition: SQLWrapper | undefined): SelectBuilder;
  orderBy(...order: SQLWrapper[]): SelectBuilder;
  groupBy(...columns: SQLWrapper[]): SelectBuilder;
  limit(value: number): SelectBuilder;
  offset(value: number): SelectBuilder;
  for(strength: 'update'): SelectBuilder;
}
interface MutationBuilder extends PromiseLike<unknown> {
  onConflictDoNothing(options: { target: AnyColumn[] }): MutationBuilder;
  where(condition: SQLWrapper | undefined): MutationBuilder;
  returning(): PromiseLike<Row[]>;
}
interface InsertBuilder {
  select(query: SQL): MutationBuilder;
  values(values: Row | Row[]): MutationBuilder;
}
interface UpdateBuilder {
  set(values: Row): MutationBuilder;
}
export interface DrizzleDatabase {
  batch?(queries: readonly unknown[]): Promise<Row[][]>;
  select(fields?: Record<string, SQL | AnyColumn | SQLWrapper>): SelectBuilder;
  insert(table: Table): InsertBuilder;
  update(table: Table): UpdateBuilder;
  delete(table: Table): MutationBuilder;
  transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}

/** Trusted ORM reflection only. Never call with request payloads. */
export function asDatabase(handle: unknown): DrizzleDatabase {
  if (
    typeof handle !== 'object' ||
    handle === null ||
    !('select' in handle) ||
    typeof handle.select !== 'function' ||
    !('insert' in handle) ||
    typeof handle.insert !== 'function' ||
    !('update' in handle) ||
    typeof handle.update !== 'function' ||
    !('delete' in handle) ||
    typeof handle.delete !== 'function' ||
    !('transaction' in handle) ||
    typeof handle.transaction !== 'function'
  ) {
    throw new Error('Expected a Drizzle database handle');
  }
  // Deliberate ORM overload erasure, not a type guard proving builder signatures.
  return handle as DrizzleDatabase;
}

export function readRow(value: unknown): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a database row');
  }
  return Object.fromEntries(Object.entries(value));
}

/** Public clients retain upstream CRUD method checks. Transaction overloads depend
 * on the caller's entire schema, so only that callable is erased at reflection.
 * No calls can be made through this uninhabitable argument list. */
type TransactionMethod = { transaction: (...args: never[]) => unknown };
export type DrizzleHandle = TransactionMethod &
  (
    | Pick<BaseSQLiteDatabase<'sync' | 'async', unknown>, 'select' | 'insert' | 'update' | 'delete'>
    | Pick<PgDatabase<PgQueryResultHKT>, 'select' | 'insert' | 'update' | 'delete'>
    | Pick<
        MySqlDatabase<MySqlQueryResultHKT, PreparedQueryHKTBase>,
        'select' | 'insert' | 'update' | 'delete'
      >
  );
export type DrizzleD1Handle = TransactionMethod &
  Pick<DrizzleD1Database, 'select' | 'insert' | 'update' | 'delete' | 'batch'>;

/** A scope belongs to one exact native handle and only to its callback lifetime. */
class OwnedDrizzleScope implements AdapterScope {
  #active = true;
  readonly #owner: object;
  readonly tx: unknown;

  constructor(owner: object, tx: unknown) {
    this.#owner = owner;
    this.tx = tx;
    Object.freeze(this);
  }

  database(owner: object, fallback?: DrizzleDatabase): DrizzleDatabase {
    if (!this.#active || this.#owner !== owner)
      throw new TypeError('Foreign or expired Drizzle database scope');
    return this.tx == null ? (fallback ?? asDatabase(owner)) : asDatabase(this.tx);
  }

  close(): void {
    this.#active = false;
  }
}

/** Adapter-internal scope factory; no ambient or global connection state. */
export async function withDrizzleScope<T>(
  owner: object,
  tx: unknown,
  work: (scope: AdapterScope) => Promise<T>,
): Promise<T> {
  const scope = new OwnedDrizzleScope(owner, tx);
  try {
    return await work(scope);
  } finally {
    scope.close();
  }
}

/** Reject fabricated, foreign and expired scopes before using their native tx. */
export function databaseForScope(
  owner: object,
  scope: AdapterScope,
  fallback?: DrizzleDatabase,
): DrizzleDatabase {
  if (!(scope instanceof OwnedDrizzleScope))
    throw new TypeError('Foreign or expired Drizzle database scope');
  return scope.database(owner, fallback);
}
