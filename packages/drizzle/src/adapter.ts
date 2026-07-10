/**
 * `@velajs/crud-drizzle` — Drizzle ORM `CrudAdapter` (sqlite / pg / mysql).
 *
 * Cross-adapter semantics mirror the memory reference adapter: soft-delete
 * visibility, literal-needle inline search, strictly-after keyset cursors
 * with `page: 0`, lenient malformed-cursor fallback. All methods operate on
 * `(scope.tx ?? db)` so everything the engine wraps in `transaction()` is
 * atomic.
 *
 * Capability honesty:
 * - NO `nativeSearch` — hono-crud's drizzle search was LIKE-based; the
 *   engine's scoring fallback is equivalent and keeps one code path.
 * - NO `upsert` — the engine's find→(restore+update | create) synthesis runs
 *   inside a REAL transaction here, is atomic, and keeps the `created` flag
 *   exact. hono-crud used ON CONFLICT; the tradeoff is recorded in PARITY.md.
 * - `databaseGeneratedId` relies on RETURNING (sqlite/pg). The mysql branch
 *   follows hono-crud's insertId pattern but is NOT exercised by tests.
 */

import {
  asc as drizzleAsc,
  desc as drizzleDesc,
  eq,
  isNull,
  sql,
} from 'drizzle-orm';
import type {
  AdapterCapability,
  AdapterScope,
  BulkOutcome,
  CascadeDriver,
  CrudAdapter,
  DeleteOptions,
  FilterCondition,
  ListQuery,
  Lookup,
  NestedWriteDriver,
  NestedWriteOperations,
  Page,
  PageInfo,
  ReadOptions,
  RelationLoadScope,
  RelationLoader,
  TransactionContext,
} from '@velajs/crud/adapter';
import { decodeCursor, encodeCursor } from '@velajs/crud/query';
import { asDatabase, type DrizzleDatabase, type DrizzleDialect, type DrizzleSql, type DrizzleTable } from './database';
import { andAll, buildWhere, getColumn, orAll, substringMatch } from './filters';

type Row = Record<string, unknown>;

export interface DrizzleRelation {
  type: 'hasOne' | 'hasMany' | 'belongsTo';
  /** The related Drizzle table. */
  table: DrizzleTable;
  /** FK column: on the related table for hasOne/hasMany, on the parent for belongsTo. */
  foreignKey: string;
  /** Join column on the owning side (defaults to the primary key). */
  localKey?: string;
}

export interface DrizzleAdapterConfig {
  /** A Drizzle database client (sqlite, pg, or mysql flavor). */
  db: unknown;
  /** @default 'sqlite' */
  dialect?: DrizzleDialect;
  table: DrizzleTable;
  /** @default 'id' */
  primaryKey?: string;
  /** Soft-delete column, when the model soft-deletes. */
  softDeleteField?: string;
  relations?: Record<string, DrizzleRelation>;
  /**
   * Called inside every engine-opened transaction, right after it opens and
   * before any statement runs — the seam for per-transaction session state,
   * e.g. a Postgres RLS GUC: `SELECT set_config('app.tenant_id', <tenant>, true)`
   * via `tx.execute(...)`. Receives the raw Drizzle transaction handle.
   * Invoked only when the caller passed a `TransactionContext` (the engine
   * always does).
   */
  onOpenTransaction?: (tx: unknown, ctx: TransactionContext) => void | Promise<void>;
}

const CAPABILITIES: ReadonlySet<AdapterCapability> = new Set([
  'transactions',
  'databaseGeneratedId',
  'cursor',
  'aggregate',
  'bulkPatch',
  'nativeBatch',
  'restore',
  'nestedWrites',
  'cascade',
  'softDelete',
] as const);

export function drizzleAdapter<R extends Row = Row>(config: DrizzleAdapterConfig): CrudAdapter<R> {
  const dialect: DrizzleDialect = config.dialect ?? 'sqlite';
  const table = config.table;
  const primaryKey = config.primaryKey ?? 'id';
  const rootDb = asDatabase(config.db);

  const handle = (scope: AdapterScope): DrizzleDatabase =>
    scope.tx != null ? asDatabase(scope.tx) : rootDb;

  const pkColumn = () => getColumn(table, primaryKey);

  const softDeleteVisibility = (withDeleted: boolean): DrizzleSql | undefined =>
    config.softDeleteField !== undefined && !withDeleted
      ? isNull(getColumn(table, config.softDeleteField))
      : undefined;

  const lookupWhere = (lookup: Lookup, withDeleted: boolean): DrizzleSql | undefined =>
    andAll(
      eq(getColumn(table, lookup.field), lookup.value),
      ...Object.entries(lookup.filters ?? {}).map(([field, value]) =>
        eq(getColumn(table, field), value),
      ),
      softDeleteVisibility(withDeleted),
    );

  const selectOne = async (db: DrizzleDatabase, where: DrizzleSql | undefined): Promise<R | null> => {
    const rows = (await db.select().from(table).where(where).limit(1)) as R[];
    return rows[0] ?? null;
  };

  const nested: NestedWriteDriver<R> = {
    async createNested(parent, relation, records, scope) {
      const rel = requireRelation(config, relation);
      const db = handle(scope);
      const parentKey = (parent as Row)[rel.localKey ?? primaryKey];
      for (const record of records) {
        const row = { ...record, id: record.id ?? crypto.randomUUID(), [rel.foreignKey]: parentKey };
        await db.insert(rel.table).values(row);
      }
    },
    async applyNested(parent, relation, operations: NestedWriteOperations, scope) {
      const rel = requireRelation(config, relation);
      const db = handle(scope);
      const parentKey = (parent as Row)[rel.localKey ?? primaryKey];
      const fk = getColumn(rel.table, rel.foreignKey);
      const matches = (where: Row): DrizzleSql | undefined =>
        andAll(...Object.entries(where).map(([k, v]) => eq(getColumn(rel.table, k), v)));

      for (const record of operations.create ?? []) {
        const row = { ...record, id: record.id ?? crypto.randomUUID(), [rel.foreignKey]: parentKey };
        await db.insert(rel.table).values(row);
      }
      for (const { where, data } of operations.update ?? []) {
        await db.update(rel.table).set(data).where(andAll(matches(where), eq(fk, parentKey)));
      }
      for (const where of operations.delete ?? []) {
        await db.delete(rel.table).where(andAll(matches(where), eq(fk, parentKey)));
      }
      for (const where of operations.connect ?? []) {
        await db.update(rel.table).set({ [rel.foreignKey]: parentKey }).where(matches(where));
      }
      for (const where of operations.disconnect ?? []) {
        await db.update(rel.table).set({ [rel.foreignKey]: null }).where(andAll(matches(where), eq(fk, parentKey)));
      }
      if (operations.set) {
        await db.update(rel.table).set({ [rel.foreignKey]: null }).where(eq(fk, parentKey));
        for (const where of operations.set) {
          await db.update(rel.table).set({ [rel.foreignKey]: parentKey }).where(matches(where));
        }
      }
    },
  };

  const cascade: CascadeDriver = {
    async countRelated(relation, parentKey, scope) {
      const rel = requireRelation(config, relation);
      const rows = (await handle(scope)
        .select({ count: sql`count(*)` })
        .from(rel.table)
        .where(eq(getColumn(rel.table, rel.foreignKey), parentKey))) as Array<{ count: unknown }>;
      return Number(rows[0]?.count) || 0;
    },
    async deleteRelated(relation, parentKey, scope) {
      const rel = requireRelation(config, relation);
      const count = await cascade.countRelated(relation, parentKey, scope);
      await handle(scope).delete(rel.table).where(eq(getColumn(rel.table, rel.foreignKey), parentKey));
      return count;
    },
    async nullifyRelated(relation, parentKey, scope) {
      const rel = requireRelation(config, relation);
      const count = await cascade.countRelated(relation, parentKey, scope);
      await handle(scope)
        .update(rel.table)
        .set({ [rel.foreignKey]: null })
        .where(eq(getColumn(rel.table, rel.foreignKey), parentKey));
      return count;
    },
  };

  const relations: RelationLoader<R> = {
    async load(rows, relation, loadScope: RelationLoadScope, scope) {
      const rel = requireRelation(config, relation);
      const db = handle(scope);
      const relatedJoinField = rel.type === 'belongsTo' ? (rel.localKey ?? 'id') : rel.foreignKey;
      const parentJoinField = rel.type === 'belongsTo' ? rel.foreignKey : (rel.localKey ?? primaryKey);
      const wanted = [...new Set(rows.map((r) => (r as Row)[parentJoinField]))].filter(
        (v) => v !== null && v !== undefined,
      );

      const grouped = new Map<unknown, Row[]>();
      if (wanted.length === 0) return grouped;

      // WHERE pushdown of the owner scope (tenant + soft-delete exclusion).
      const conditions = andAll(
        orAll(...wanted.map((v) => eq(getColumn(rel.table, relatedJoinField), v))),
        loadScope.tenantField != null && loadScope.tenantValue != null
          ? eq(getColumn(rel.table, loadScope.tenantField), loadScope.tenantValue)
          : undefined,
        loadScope.excludeDeletedField != null
          ? isNull(getColumn(rel.table, loadScope.excludeDeletedField))
          : undefined,
      );
      const related = (await db.select().from(rel.table).where(conditions)) as Row[];
      for (const row of related) {
        const key = row[relatedJoinField];
        const bucket = grouped.get(key);
        if (bucket) bucket.push(row);
        else grouped.set(key, [row]);
      }
      return grouped;
    },
  };

  return {
    capabilities: CAPABILITIES,

    async transaction<T>(fn: (scope: AdapterScope) => Promise<T>, ctx?: TransactionContext): Promise<T> {
      return rootDb.transaction(async (tx) => {
        if (ctx !== undefined) await config.onOpenTransaction?.(tx, ctx);
        return fn({ tx });
      });
    },

    async create(input, scope) {
      const db = handle(scope);
      if (dialect === 'mysql') {
        // mysql has no RETURNING: insert then re-select by PK (client-supplied)
        // or insertId (database-generated). Written per hono-crud; UNTESTED.
        const result = (await db.insert(table).values(input)) as { insertId?: number | string };
        const pk = (input as Row)[primaryKey] ?? result.insertId;
        const row = await selectOne(db, eq(pkColumn(), pk));
        if (!row) throw new Error('drizzleAdapter: created row not found after insert');
        return row;
      }
      const rows = (await db.insert(table).values(input).returning()) as R[];
      const created = rows[0];
      if (!created) throw new Error('drizzleAdapter: insert returned no row');
      return created;
    },

    async readOne(lookup, opts: ReadOptions, scope) {
      return selectOne(handle(scope), lookupWhere(lookup, opts.withDeleted ?? false));
    },

    async update(lookup, patch, scope) {
      const db = handle(scope);
      const where = lookupWhere(lookup, false);
      const existing = await selectOne(db, where);
      if (!existing) return null;
      await db.update(table).set(patch).where(where);
      return selectOne(db, eq(pkColumn(), (existing as Row)[primaryKey]));
    },

    async delete(lookup, opts: DeleteOptions, scope) {
      const db = handle(scope);
      const where = lookupWhere(lookup, false);
      const existing = await selectOne(db, where);
      if (!existing) return null;
      if (opts.softDeleteField !== undefined) {
        await db.update(table).set({ [opts.softDeleteField]: Date.now() }).where(where);
        return selectOne(db, eq(pkColumn(), (existing as Row)[primaryKey]));
      }
      await db.delete(table).where(where);
      return existing;
    },

    async restore(lookup, scope) {
      if (config.softDeleteField === undefined) return null;
      const db = handle(scope);
      // Deleted-aware lookup: match soft-deleted rows too.
      const existing = await selectOne(db, lookupWhere(lookup, true));
      if (!existing) return null;
      if ((existing as Row)[config.softDeleteField] == null) return null; // not deleted
      await db
        .update(table)
        .set({ [config.softDeleteField]: null })
        .where(eq(pkColumn(), (existing as Row)[primaryKey]));
      return selectOne(db, eq(pkColumn(), (existing as Row)[primaryKey]));
    },

    async list(query: ListQuery, scope): Promise<Page<R>> {
      const db = handle(scope);
      const { options } = query;

      const visibility =
        config.softDeleteField !== undefined
          ? options.onlyDeleted
            ? sql`${getColumn(table, config.softDeleteField)} IS NOT NULL`
            : options.withDeleted
              ? undefined
              : isNull(getColumn(table, config.softDeleteField))
          : undefined;

      // Inline search: literal case-insensitive needle across searchFields.
      const search =
        options.search && options.searchFields && options.searchFields.length > 0
          ? orAll(
              ...options.searchFields.map((field) =>
                substringMatch(getColumn(table, field), options.search as string, dialect),
              ),
            )
          : undefined;

      const where = andAll(buildWhere(table, query.filters, dialect), visibility, search);

      const countRows = (await db
        .select({ count: sql`count(*)` })
        .from(table)
        .where(where)) as Array<{ count: unknown }>;
      const totalCount = Number(countRows[0]?.count) || 0;

      // Keyset cursor pagination (next-only, strictly-after, page 0).
      if (options.cursor !== undefined || options.limit !== undefined) {
        const cursorField = options.order_by ?? primaryKey;
        const limit = options.limit ?? options.per_page ?? 20;
        let decoded: string | null = null;
        if (options.cursor !== undefined) {
          try {
            decoded = decodeCursor(options.cursor);
          } catch {
            decoded = null; // start from the beginning (cross-adapter parity)
          }
        }
        const column = getColumn(table, cursorField);
        const windowWhere = andAll(where, decoded !== null ? sql`${column} > ${decoded}` : undefined);
        const rows = (await db
          .select()
          .from(table)
          .where(windowWhere)
          .orderBy(drizzleAsc(column))
          .limit(limit + 1)) as R[];

        const pageItems = rows.slice(0, limit);
        const hasNext = rows.length > limit;
        const last = pageItems[pageItems.length - 1] as Row | undefined;
        const info: PageInfo = {
          page: 0,
          per_page: limit,
          total_count: totalCount,
          has_next_page: hasNext,
          has_prev_page: decoded !== null,
          ...(hasNext && last !== undefined
            ? { next_cursor: encodeCursor(String(last[cursorField])) }
            : {}),
        };
        return { result: pageItems, result_info: info };
      }

      // Offset pagination.
      const page = options.page ?? 1;
      const perPage = options.per_page ?? 20;
      let builder = db.select().from(table).where(where);
      if (options.order_by) {
        const column = getColumn(table, options.order_by);
        builder = builder.orderBy(
          options.order_by_direction === 'desc' ? drizzleDesc(column) : drizzleAsc(column),
        );
      }
      const rows = (await builder.limit(perPage).offset((page - 1) * perPage)) as R[];
      const totalPages = Math.ceil(totalCount / perPage);
      return {
        result: rows,
        result_info: {
          page,
          per_page: perPage,
          total_count: totalCount,
          total_pages: totalPages,
          has_next_page: page < totalPages,
          has_prev_page: page > 1,
        },
      };
    },

    async aggregate(spec, scope) {
      const db = handle(scope);
      const where = buildWhere(table, spec.filters, dialect);

      const fields: Record<string, DrizzleSql> = {};
      const aggregations = spec.aggregations ?? [
        { operation: spec.operation, field: spec.field ?? '*' },
      ];
      for (const agg of aggregations) {
        const alias = agg.alias ?? deriveAlias(agg.operation, agg.field);
        fields[alias] = aggregateSql(table, agg.operation, agg.field);
      }
      const groupBy = spec.groupBy ?? [];
      for (const group of groupBy) fields[group] = getColumn(table, group);

      let builder = db.select(fields).from(table).where(where);
      if (groupBy.length > 0) {
        builder = builder.groupBy(...groupBy.map((g) => getColumn(table, g)));
      }
      const buckets = (await builder) as Array<Record<string, unknown>>;
      const aliases = aggregations.map((agg) => agg.alias ?? deriveAlias(agg.operation, agg.field));

      if (groupBy.length === 0) {
        const first = buckets[0] ?? {};
        const values: Record<string, number | null> = {};
        for (const alias of aliases) {
          values[alias] = first[alias] == null ? null : Number(first[alias]);
        }
        return { values };
      }

      const groups = buckets.map((bucket) => {
        const key: Record<string, unknown> = {};
        for (const g of groupBy) key[g] = bucket[g];
        const values: Record<string, number | null> = {};
        for (const alias of aliases) {
          values[alias] = bucket[alias] == null ? null : Number(bucket[alias]);
        }
        return { key, values };
      });
      return { groups, totalGroups: groups.length };
    },

    async updateWhere(filters: FilterCondition[], patch, scope): Promise<BulkOutcome<R>> {
      const db = handle(scope);
      const visibility = softDeleteVisibility(false);
      const where = andAll(buildWhere(table, filters, dialect), visibility);
      const matched = (await db.select().from(table).where(where)) as R[];
      if (matched.length === 0) return { count: 0, records: [] };
      await db.update(table).set(patch).where(where);
      const pks = matched.map((row) => (row as Row)[primaryKey]);
      const updated = (await db
        .select()
        .from(table)
        .where(orAll(...pks.map((pk) => eq(pkColumn(), pk))))) as R[];
      return { count: updated.length, records: updated };
    },

    async createMany(rows, scope) {
      const db = handle(scope);
      if (rows.length === 0) return [];
      if (dialect === 'mysql') {
        // Per-row insert + re-select (no RETURNING). UNTESTED.
        const out: R[] = [];
        for (const row of rows) {
          await db.insert(table).values(row);
          const pk = (row as Row)[primaryKey];
          const created = await selectOne(db, eq(pkColumn(), pk));
          if (created) out.push(created);
        }
        return out;
      }
      return (await db.insert(table).values(rows).returning()) as R[];
    },

    nested,
    cascade,
    relations,
  };
}

function requireRelation(config: DrizzleAdapterConfig, relation: string): DrizzleRelation {
  const rel = config.relations?.[relation];
  if (!rel) {
    throw new Error(`drizzleAdapter: unknown relation '${relation}' — declare it in config.relations`);
  }
  return rel;
}

function deriveAlias(operation: string, field: string): string {
  if (operation === 'count' && (field === '*' || field === '')) return 'count';
  const pascal = field.charAt(0).toUpperCase() + field.slice(1);
  return `${operation}${pascal}`;
}

function aggregateSql(table: DrizzleTable, operation: string, field: string): DrizzleSql {
  const column = field === '*' || field === '' ? undefined : getColumn(table, field);
  switch (operation) {
    case 'count':
      return column ? sql`count(${column})` : sql`count(*)`;
    case 'countDistinct':
      return sql`count(distinct ${column})`;
    case 'sum':
      return sql`sum(${column})`;
    case 'avg':
      return sql`avg(${column})`;
    case 'min':
      return sql`min(${column})`;
    case 'max':
      return sql`max(${column})`;
    default:
      throw new Error(`drizzleAdapter: unsupported aggregate operation '${operation}'`);
  }
}
