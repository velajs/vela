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
import { CrudException } from '@velajs/crud';
import { assertNever, type FilterCondition, type QueryPredicate } from '@velajs/crud/adapter';
import {
  readRow,
  type DrizzleColumn,
  type DrizzleDialect,
  type DrizzleSql,
  type DrizzleTable,
} from './database';

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
  if (filter.operator === 'predicate') return buildPredicate(table, filter.value, dialect);
  const column = getColumn(table, filter.field);

  const operator = filter.operator;
  switch (operator) {
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
      return assertNever(operator);
  }
}

/** COALESCE makes negation two-valued, including nullable SQL columns. */
export function buildPredicate(
  table: DrizzleTable,
  p: QueryPredicate,
  dialect: DrizzleDialect,
): DrizzleSql {
  switch (p.op) {
    case 'true':
      return sql`TRUE`;
    case 'false':
      return sql`FALSE`;
    case 'and':
      return p.args.length
        ? drizzleAnd(...p.args.map((v) => buildPredicate(table, v, dialect)))!
        : sql`TRUE`;
    case 'or':
      return p.args.length
        ? drizzleOr(...p.args.map((v) => buildPredicate(table, v, dialect)))!
        : sql`FALSE`;
    case 'not':
      return sql`NOT (${buildPredicate(table, p.arg, dialect)})`;
    default:
      break;
  }
  const column = getColumn(table, p.field);
  switch (p.op) {
    // Relational rows have every mapped column, even when its value is null.
    case 'has':
      return sql`TRUE`;
    case 'pattern': {
      if (dialect === 'mysql')
        throw new Error('Exact Cedar pattern matching is unsupported on MySQL');
      const pattern = p.tokens
        .map((token) =>
          token === null
            ? dialect === 'sqlite'
              ? '*'
              : '%'
            : dialect === 'sqlite'
              ? token.replace(/\[/g, '[[]').replace(/\*/g, '[*]').replace(/\?/g, '[?]')
              : token.replace(/[!%_]/g, '!$&'),
        )
        .join('');
      return dialect === 'sqlite'
        ? sql`COALESCE(${column} GLOB ${pattern}, FALSE)`
        : sql`COALESCE(${column} LIKE ${pattern} ESCAPE '!', FALSE)`;
    }
    case 'isNull':
      return isNull(column);
    case 'eq':
      return p.value === null ? isNull(column) : sql`COALESCE(${eq(column, p.value)}, FALSE)`;
    case 'in':
      return p.values.length
        ? drizzleOr(
            ...p.values.map((v) =>
              buildPredicate(table, { op: 'eq', field: p.field, value: v }, dialect),
            ),
          )!
        : sql`FALSE`;
    case 'lt':
      return sql`COALESCE(${lt(column, p.value)}, FALSE)`;
    case 'lte':
      return sql`COALESCE(${lte(column, p.value)}, FALSE)`;
    case 'gt':
      return sql`COALESCE(${gt(column, p.value)}, FALSE)`;
    case 'gte':
      return sql`COALESCE(${gte(column, p.value)}, FALSE)`;
    case 'contains':
      return sql`COALESCE(${substringMatch(column, String(p.value), dialect, { caseSensitive: true })}, FALSE)`;
    case 'startsWith':
      return sql`COALESCE(SUBSTR(${column}, 1, ${[...String(p.value)].length}) = ${p.value}, FALSE)`;
    case 'endsWith': {
      const n = [...String(p.value)].length;
      return n === 0
        ? isNotNull(column)
        : sql`COALESCE(SUBSTR(${column}, LENGTH(${column}) - ${n} + 1) = ${p.value}, FALSE)`;
    }
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

/** D1's per-statement limit also applies to every member of a batch. */
export const D1_MAX_BOUND_PARAMETERS = 100;

/** Trusted Drizzle reflection boundary. Count the compiled statement, including
 * column encoders, fixed predicates, defaults, and pagination parameters. */
export function queryParameterCount(query: unknown): number {
  if (
    !query ||
    typeof query !== 'object' ||
    !('toSQL' in query) ||
    typeof query.toSQL !== 'function'
  )
    throw new TypeError('Expected a compilable Drizzle query');
  return compiledParameterCount(query.toSQL());
}

function compiledParameterCount(compiled: unknown): number {
  if (
    !compiled ||
    typeof compiled !== 'object' ||
    !('params' in compiled) ||
    !Array.isArray(compiled.params)
  )
    throw new TypeError('Expected Drizzle query parameters');
  return compiled.params.length;
}

export function assertD1ParameterCount(count: number): void {
  if (count > D1_MAX_BOUND_PARAMETERS)
    throw new CrudException(
      `D1 query exceeds ${D1_MAX_BOUND_PARAMETERS} bound parameters`,
      400,
      'QUERY_PARAMETER_LIMIT',
    );
}

/** Prepare once, then budget and execute that exact compiled statement. This
 * avoids calling Drizzle runtime defaults again between inspection and execution.
 * The opaque _prepare slot is the Drizzle D1 batch protocol: it receives the
 * same prepared query, preserving the driver's row mapper and atomic batching. */
export function checkedD1Query(
  query: unknown,
): PromiseLike<Record<string, unknown>[]> & { _prepare(): unknown } {
  if (
    !query ||
    typeof query !== 'object' ||
    !('prepare' in query) ||
    typeof query.prepare !== 'function'
  )
    throw new TypeError('Expected a preparable Drizzle query');
  const prepared: unknown = query.prepare();
  if (
    !prepared ||
    typeof prepared !== 'object' ||
    !('getQuery' in prepared) ||
    typeof prepared.getQuery !== 'function' ||
    !('execute' in prepared) ||
    typeof prepared.execute !== 'function'
  )
    throw new TypeError('Expected a prepared Drizzle query');
  assertD1ParameterCount(compiledParameterCount(prepared.getQuery()));
  const executePrepared = prepared.execute.bind(prepared);
  const execute = async (): Promise<Record<string, unknown>[]> => {
    const result: unknown = await executePrepared();
    if (!Array.isArray(result)) throw new TypeError('Expected Drizzle result rows');
    return result.map(readRow);
  };
  return {
    _prepare: () => prepared,
    // Deliberately implement Drizzle's lazy PromiseLike query contract.
    // oxlint-disable-next-line unicorn/no-thenable
    then: (fulfilled, rejected) => execute().then(fulfilled, rejected),
  };
}
