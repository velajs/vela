/**
 * FilterCondition → Drizzle SQL. Ported from hono-crud 0.13's drizzle helpers
 * (`buildWhereCondition` + `substringMatch`) so the cross-adapter contracts
 * hold: fail-closed operators, literal-needle like/ilike (`%` stripped, `_`
 * inert — never live SQL wildcards), dialect-aware substring predicates.
 */

import {
  and as drizzleAnd,
  between,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or as drizzleOr,
  sql,
} from 'drizzle-orm';
import { assertNever, type FilterCondition } from '@velajs/crud/adapter';
import type { DrizzleColumn, DrizzleDialect, DrizzleSql, DrizzleTable } from './database';

/** `and` that tolerates undefined members and collapses to undefined. */
export function andAll(...conditions: Array<DrizzleSql | undefined>): DrizzleSql | undefined {
  const present = conditions.filter((c) => c !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return drizzleAnd(...present);
}

/** `or` that tolerates undefined members and collapses to undefined. */
export function orAll(...conditions: Array<DrizzleSql | undefined>): DrizzleSql | undefined {
  const present = conditions.filter((c) => c !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return drizzleOr(...present);
}

export function getColumn(table: DrizzleTable, field: string): DrizzleColumn {
  const columns = getTableColumns(table);
  if (!Object.hasOwn(columns, field)) {
    throw new Error(`drizzleAdapter: table has no column '${field}'`);
  }
  return columns[field]!;
}

/**
 * Dialect-agnostic "needle is a substring of col" predicate. POSITION /
 * LOCATE / INSTR all return a 1-based position (0 = not found), so `> 0` is
 * the shared predicate. `caseSensitive` drops the LOWER() wrapping so case
 * behavior follows the database collation (the `like` contract).
 */
export function substringMatch(
  col: DrizzleColumn | DrizzleSql,
  needle: string,
  dialect: DrizzleDialect,
  options?: { caseSensitive?: boolean },
): DrizzleSql {
  if (options?.caseSensitive) {
    switch (dialect) {
      case 'pg':
        return sql`POSITION(${needle} IN ${col}) > 0`;
      case 'mysql':
        return sql`LOCATE(${needle}, ${col}) > 0`;
      default:
        return sql`INSTR(${col}, ${needle}) > 0`;
    }
  }
  switch (dialect) {
    case 'pg':
      return sql`POSITION(LOWER(${needle}) IN LOWER(${col})) > 0`;
    case 'mysql':
      return sql`LOCATE(LOWER(${needle}), LOWER(${col})) > 0`;
    default:
      return sql`INSTR(LOWER(${col}), LOWER(${needle})) > 0`;
  }
}

/** One FilterCondition → one Drizzle condition (exhaustive over the union). */
export function buildWhereCondition(
  table: DrizzleTable,
  filter: FilterCondition,
  dialect: DrizzleDialect,
): DrizzleSql {
  const column = getColumn(table, filter.field);

  switch (filter.operator) {
    case 'eq':
      return eq(column, filter.value);
    case 'ne':
      return ne(column, filter.value);
    case 'gt':
      return gt(column, filter.value);
    case 'gte':
      return gte(column, filter.value);
    case 'lt':
      return lt(column, filter.value);
    case 'lte':
      return lte(column, filter.value);
    case 'in':
      return inArray(column, filter.value as unknown[]);
    case 'nin':
      return notInArray(column, filter.value as unknown[]);
    case 'like':
      // Literal substring; case behavior follows the database collation.
      return substringMatch(column, String(filter.value).replace(/%/g, ''), dialect, {
        caseSensitive: true,
      });
    case 'ilike':
      // Always case-insensitive (drizzle's ilike() is PostgreSQL-only SQL).
      return substringMatch(column, String(filter.value).replace(/%/g, ''), dialect);
    case 'null':
      return filter.value ? isNull(column) : isNotNull(column);
    case 'between': {
      const [min, max] = filter.value as [unknown, unknown];
      return between(column, min, max);
    }
    default:
      // Operators are validated upstream; a new union member fails to compile.
      return assertNever(filter.operator);
  }
}

/** All filters AND'd, or undefined for an empty set. */
export function buildWhere(
  table: DrizzleTable,
  filters: FilterCondition[],
  dialect: DrizzleDialect,
): DrizzleSql | undefined {
  return andAll(...filters.map((f) => buildWhereCondition(table, f, dialect)));
}
