import { bindAdapter } from '@velajs/crud/adapter';
import { atomicBatchDriver } from './atomic';
/**
 * `@velajs/crud-drizzle` — Drizzle ORM `CrudAdapter` (sqlite / pg / mysql).
 *
 * Cross-adapter semantics mirror the memory reference adapter: soft-delete
 * visibility, literal-needle inline search, strictly-after keyset cursors
 * with `page: 0` and engine-validated compound boundaries. All methods operate on
 * `(scope.tx ?? db)` so everything the engine wraps in `transaction()` is
 * atomic. D1 uses ordinary request scopes and single-statement mutations.
 *
 * Capability honesty:
 * - NO `nativeSearch` — hono-crud's drizzle search was LIKE-based; the
 *   engine's scoring fallback is equivalent and keeps one code path.
 * - sqlite/pg can opt into scoped native upserts with `atomicUpsert`, using
 *   real unique conflict targets. Non-native upserts use transaction synthesis.
 * - `databaseGeneratedId` relies on RETURNING (sqlite/pg). The mysql branch
 *   follows hono-crud's insertId pattern but is NOT exercised by tests.
 */

import {
  asc as drizzleAsc,
  desc as drizzleDesc,
  eq,
  inArray,
  gt,
  lt,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';
import type {
  AdapterCapability,
  AdapterScope,
  BulkOutcome,
  CrudAdapter,
  DeleteOptions,
  FilterCondition,
  ListQuery,
  Lookup,
  NestedWriteDriver,
  NestedWriteOperations,
  Page,
  ReadOptions,
  RelationLoadScope,
  RelationLoader,
  TransactionContext,
} from '@velajs/crud/adapter';
import { ConflictException, CrudException } from '@velajs/crud';
import { buildKeysetPage } from '@velajs/crud/query';
import {
  asDatabase,
  withDrizzleScope,
  databaseForScope,
  readRow,
  type DrizzleDatabase,
  type DrizzleHandle,
  type DrizzleD1Handle,
  type DrizzleDialect,
  type DrizzleSql,
  type DrizzleTable,
} from './database';
import {
  assertD1ParameterCount,
  D1_MAX_BOUND_PARAMETERS,
  queryParameterCount,
  checkedD1Query,
  andAll,
  buildPredicate,
  buildWhere,
  getColumn,
  orAll,
  substringMatch,
} from './filters';

type Row = Record<string, unknown>;

const UNSAFE_DYNAMIC_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_RESULT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertSafeResultKey(value: string, kind: 'aggregate alias' | 'group field'): void {
  if (!SAFE_RESULT_KEY.test(value) || UNSAFE_DYNAMIC_KEYS.has(value)) {
    throw new Error(`drizzleAdapter: unsafe ${kind} '${value}'`);
  }
}

export interface DrizzleRelation {
  type: 'hasOne' | 'hasMany' | 'belongsTo';
  /** The related Drizzle table. */
  table: DrizzleTable;
  /** FK column: on the related table for hasOne/hasMany, on the parent for belongsTo. */
  foreignKey: string;
  /** Join column on the owning side (defaults to the primary key). */
  localKey?: string;
}

interface DrizzleAdapterOptions {
  /** Shared native transaction boundary (e.g. one Durable Object storage).
   * Defaults to db. Only share across handles for that same physical boundary. */
  transactionOwner?: object;
  table: DrizzleTable;
  /** @default 'id' */
  primaryKey?: string;
  primaryKeys?: readonly string[];
  /** Opt into race-safe native upserts. Every conflict target must have a
   * database PRIMARY KEY/UNIQUE constraint. Unsupported on MySQL. Default false. */
  atomicUpsert?: boolean;
  /** Soft-delete column, when the model soft-deletes. */
  softDeleteField?: string;
  relations?: Record<string, DrizzleRelation>;
}

export type DrizzleAdapterConfig = DrizzleAdapterOptions &
  (
    | {
        driver: 'd1';
        dialect?: 'sqlite';
        db: DrizzleD1Handle;
        onOpenTransaction?: never;
      }
    | {
        driver?: 'transactional';
        dialect?: DrizzleDialect;
        db: DrizzleHandle;
        /** Sets transaction-local context (including RLS); read scopes open a
         * real transaction when configured, preserving tenant isolation. */
        onOpenTransaction?: (tx: unknown, ctx: TransactionContext) => void | Promise<void>;
      }
  );

const CAPABILITIES: ReadonlySet<AdapterCapability> = new Set([
  'upsert',
  'scopedUpsert',
  'structuredPredicates',
  'nestedPredicates',
  'transactions',
  'rowLocks',
  'atomicMutations',
  'atomicBatch',
  'databaseGeneratedId',
  'cursor',
  'aggregate',
  'bulkPatch',
  'nativeBatch',
  'restore',
  'nestedWrites',
  'softDelete',
  'uniqueConstraints',
] as const);

/**
 * Translate driver unique-violation errors to a 409 ConflictException —
 * adapter-owned so the default envelope renders 409 natively (errorMappers
 * stays the custom-envelope escape hatch). Covers sqlite/libsql message +
 * codes, pg 23505, mysql 1062/ER_DUP_ENTRY.
 */
function isUniqueViolation(err: unknown): boolean {
  // drizzle-orm wraps driver errors (DrizzleQueryError) — the violation
  // signal lives down the `cause` chain, so walk it.
  let current: unknown = err;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth++) {
    if (typeof current !== 'object') break;
    const e = readRow(current);
    const message = 'message' in current ? String(current.message) : '';
    if ('code' in current) e.code = current.code;
    if ('errno' in current) e.errno = current.errno;
    if ('cause' in current) e.cause = current.cause;
    if (
      message.includes('UNIQUE constraint failed') ||
      message.includes('duplicate key value violates unique constraint') || // pg message shape
      e.code === 'SQLITE_CONSTRAINT' ||
      e.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      e.code === '23505' ||
      e.errno === 1062 ||
      e.code === 'ER_DUP_ENTRY'
    ) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

function rethrowMapped(err: unknown): never {
  if (isUniqueViolation(err)) throw new ConflictException('Unique constraint violated');
  throw err;
}

export function drizzleAdapter<R extends Row>(
  config: DrizzleAdapterConfig & { parseRow: (value: unknown) => R },
): CrudAdapter<R>;
export function drizzleAdapter(config: DrizzleAdapterConfig): CrudAdapter<Row>;
export function drizzleAdapter(
  config: DrizzleAdapterConfig & { parseRow?: (value: unknown) => Row },
): CrudAdapter<Row> {
  const parseRow = config.parseRow ?? readRow;
  const owner = config.transactionOwner ?? config.db;
  // Synchronous SQLite callbacks cannot contain awaited statements. They keep
  // their native escape hatch but must not advertise this async batch driver.
  const supportsAtomicBatch =
    config.driver === 'd1' ||
    config.dialect === 'pg' ||
    (config.dialect !== 'mysql' && 'resultKind' in config.db && config.db.resultKind === 'async');
  if (config.atomicUpsert && config.dialect === 'mysql')
    throw new TypeError('Atomic upsert requires SQLite or PostgreSQL');
  if (
    config.driver === 'd1' &&
    ((config.dialect && config.dialect !== 'sqlite') || config.onOpenTransaction)
  ) {
    throw new Error('D1 requires sqlite and cannot use onOpenTransaction');
  }
  const nativeCapabilities = [...CAPABILITIES].filter(
    (cap) =>
      (cap !== 'rowLocks' || config.dialect === 'mysql' || supportsAtomicBatch) &&
      (cap !== 'atomicBatch' || supportsAtomicBatch) &&
      (config.atomicUpsert === true || (cap !== 'upsert' && cap !== 'scopedUpsert')),
  );
  const capabilities =
    config.driver === 'd1'
      ? new Set(
          nativeCapabilities.filter(
            (cap) => cap !== 'transactions' && cap !== 'rowLocks' && cap !== 'nestedWrites',
          ),
        )
      : config.dialect === 'mysql'
        ? new Set(
            nativeCapabilities.filter(
              (cap) =>
                cap !== 'atomicBatch' &&
                cap !== 'atomicMutations' &&
                cap !== 'upsert' &&
                cap !== 'scopedUpsert',
            ),
          )
        : new Set(nativeCapabilities);
  const requestScope = async <T>(
    fn: (scope: AdapterScope) => Promise<T>,
    ctx?: TransactionContext,
  ): Promise<T> => {
    // Postgres RLS transaction-local settings must still govern reads.
    if (config.onOpenTransaction) return transaction(fn, ctx);
    return withDrizzleScope(owner, undefined, fn);
  };
  const transaction = async <T>(
    fn: (scope: AdapterScope) => Promise<T>,
    ctx?: TransactionContext,
  ): Promise<T> => {
    if (config.driver === 'd1')
      throw new CrudException(
        'D1 does not support callback transactions required by this operation',
        400,
        'TRANSACTION_UNSUPPORTED',
      );
    return rootDb.transaction(async (tx) => {
      if (ctx !== undefined) await config.onOpenTransaction?.(tx, ctx);
      return withDrizzleScope(owner, tx, fn);
    });
  };
  const dialect: DrizzleDialect = config.dialect ?? 'sqlite';
  const table = config.table;
  const primaryKey = config.primaryKey ?? 'id';
  const primaryKeys = config.primaryKeys ?? [primaryKey];
  const rootDb = asDatabase(config.db);

  const handle = (scope: AdapterScope): DrizzleDatabase => databaseForScope(owner, scope, rootDb);

  // Preserve the fluent builder and its lazy execution. All D1 paths check the
  // final statement rather than guessing from request/filter field counts.
  const checked = (query: PromiseLike<Row[]>): PromiseLike<Row[]> =>
    config.driver === 'd1' ? checkedD1Query(query) : query;

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
      lookup.predicate ? buildPredicate(table, lookup.predicate, dialect) : undefined,
      softDeleteVisibility(withDeleted),
    );

  const selectOne = async (
    db: DrizzleDatabase,
    where: DrizzleSql | undefined,
  ): Promise<Row | null> => {
    const rows = await checked(db.select().from(table).where(where).limit(1));
    return rows[0] ? parseRow(rows[0]) : null;
  };

  const nested: NestedWriteDriver<Row> = {
    async inspectNestedTargets(parent, relation, operations, scope) {
      const rel = requireRelation(config, relation);
      const db = handle(scope);
      const parentKey = parent[rel.localKey ?? primaryKey];
      const fk = getColumn(rel.table, rel.foreignKey);
      const scopedWhere = (where: Row, mustBelongToParent: boolean): DrizzleSql | undefined =>
        andAll(
          ...Object.entries({ ...where, ...(operations.targetScope ?? {}) }).map(([field, value]) =>
            eq(getColumn(rel.table, field), value),
          ),
          mustBelongToParent ? eq(fk, parentKey) : undefined,
          operations.targetPredicate
            ? buildPredicate(rel.table, operations.targetPredicate, dialect)
            : undefined,
        );
      const find = async (where: Row, mustBelongToParent: boolean): Promise<Row | null> => {
        const rows = await db
          .select()
          .from(rel.table)
          .where(scopedWhere(where, mustBelongToParent))
          .limit(1);
        return rows[0] ?? null;
      };
      const inspect = async (
        selectors: Row[],
        mustBelongToParent: boolean,
      ): Promise<Array<Row | null>> => {
        const rows: Array<Row | null> = [];
        for (const selector of selectors) rows.push(await find(selector, mustBelongToParent));
        return rows;
      };
      const setDisconnect =
        operations.set === undefined
          ? []
          : await db.select().from(rel.table).where(eq(fk, parentKey));
      return {
        update: await inspect(
          (operations.update ?? []).map(({ where }) => where),
          true,
        ),
        delete: await inspect(operations.delete ?? [], true),
        connect: await inspect(operations.connect ?? [], false),
        disconnect: await inspect(operations.disconnect ?? [], true),
        setConnect: await inspect(operations.set ?? [], false),
        // Intentionally unscoped; the engine rejects any attached row that
        // does not satisfy the trusted target scope before `set` mutates it.
        setDisconnect,
      };
    },
    async createNested(parent, relation, records, scope) {
      const rel = requireRelation(config, relation);
      const db = handle(scope);
      const parentKey = parent[rel.localKey ?? primaryKey];
      try {
        for (const record of records) {
          const row = {
            ...record,
            id: record.id ?? crypto.randomUUID(),
            [rel.foreignKey]: parentKey,
          };
          await db.insert(rel.table).values(row);
        }
      } catch (err) {
        rethrowMapped(err);
      }
    },
    async applyNested(parent, relation, operations: NestedWriteOperations, scope) {
      const rel = requireRelation(config, relation);
      const db = handle(scope);
      const parentKey = parent[rel.localKey ?? primaryKey];
      const fk = getColumn(rel.table, rel.foreignKey);
      const matches = (where: Row): DrizzleSql | undefined =>
        andAll(
          ...Object.entries({ ...where, ...(operations.targetScope ?? {}) }).map(([k, v]) =>
            eq(getColumn(rel.table, k), v),
          ),
          operations.targetPredicate
            ? buildPredicate(rel.table, operations.targetPredicate, dialect)
            : undefined,
        );
      const targetScope = matches({});

      try {
        for (const record of operations.create ?? []) {
          const row = {
            ...record,
            id: record.id ?? crypto.randomUUID(),
            [rel.foreignKey]: parentKey,
          };
          await db.insert(rel.table).values(row);
        }
        for (const { where, data } of operations.update ?? []) {
          await db
            .update(rel.table)
            .set(data)
            .where(andAll(matches(where), eq(fk, parentKey)));
        }
        for (const where of operations.delete ?? []) {
          await db.delete(rel.table).where(andAll(matches(where), eq(fk, parentKey)));
        }
        for (const where of operations.connect ?? []) {
          await db
            .update(rel.table)
            .set({ [rel.foreignKey]: parentKey })
            .where(matches(where));
        }
        for (const where of operations.disconnect ?? []) {
          await db
            .update(rel.table)
            .set({ [rel.foreignKey]: null })
            .where(andAll(matches(where), eq(fk, parentKey)));
        }
        if (operations.set) {
          await db
            .update(rel.table)
            .set({ [rel.foreignKey]: null })
            .where(andAll(eq(fk, parentKey), targetScope));
          for (const where of operations.set) {
            await db
              .update(rel.table)
              .set({ [rel.foreignKey]: parentKey })
              .where(matches(where));
          }
        }
      } catch (err) {
        rethrowMapped(err);
      }
    },
  };

  const relations: RelationLoader<Row> = {
    async load(rows, relation, loadScope: RelationLoadScope, scope) {
      const rel = requireRelation(config, relation);
      const db = handle(scope);
      const relatedJoinField = rel.type === 'belongsTo' ? (rel.localKey ?? 'id') : rel.foreignKey;
      const parentJoinField =
        rel.type === 'belongsTo' ? rel.foreignKey : (rel.localKey ?? primaryKey);
      const wanted = [...new Set(rows.map((r) => r[parentJoinField]))].filter(
        (v) => v !== null && v !== undefined,
      );

      const grouped = new Map<unknown, Row[]>();
      if (wanted.length === 0) return grouped;

      // Fixed predicates belong to EVERY chunk. Join keys are disjoint, so
      // concatenating their groups does not change row selection or pagination.
      const fixed = andAll(
        loadScope.predicate ? buildPredicate(rel.table, loadScope.predicate, dialect) : undefined,
        loadScope.tenantField !== undefined &&
          loadScope.tenantValue !== undefined &&
          loadScope.tenantValue !== null
          ? eq(getColumn(rel.table, loadScope.tenantField), loadScope.tenantValue)
          : undefined,
        loadScope.excludeDeletedField !== undefined
          ? isNull(getColumn(rel.table, loadScope.excludeDeletedField))
          : undefined,
      );
      let chunkSize = wanted.length;
      if (config.driver === 'd1') {
        const fixedCount = queryParameterCount(db.select().from(rel.table).where(fixed));
        // Even one parent needs one bound value. Fail before issuing any query
        // if the fixed scope leaves no budget for a join key.
        assertD1ParameterCount(fixedCount + 1);
        chunkSize = D1_MAX_BOUND_PARAMETERS - fixedCount;
      }
      for (let offset = 0; offset < wanted.length; offset += chunkSize) {
        const keys = wanted.slice(offset, offset + chunkSize);
        const conditions = andAll(fixed, inArray(getColumn(rel.table, relatedJoinField), keys));
        // Bound concurrent work on one connection as well as statement size.
        // oxlint-disable-next-line eslint/no-await-in-loop
        const related = await checked(db.select().from(rel.table).where(conditions));
        for (const row of related) {
          const key = row[relatedJoinField];
          const bucket = grouped.get(key);
          if (bucket) bucket.push(row);
          else grouped.set(key, [row]);
        }
      }
      return grouped;
    },
  };

  return bindAdapter({
    capabilities,
    transactionOwner: owner,
    ...(config.atomicUpsert !== true
      ? {}
      : {
          async upsertOne(
            input: import('@velajs/crud/adapter').UpsertInput<Row>,
            scope: AdapterScope,
          ) {
            if (
              !input.conflictTarget.length ||
              input.conflictTarget.some((key) => input.values[key] == null)
            )
              throw new CrudException(
                'Upsert requires every conflict key',
                400,
                'VALIDATION_ERROR',
              );
            const db = handle(scope);
            const insert = db
              .insert(table)
              .values(input.values)
              .onConflictDoNothing({
                target: input.conflictTarget.map((key) => getColumn(table, key)),
              })
              .returning();
            const patch = Object.fromEntries(
              Object.entries(input.values).filter(([key]) => !primaryKeys.includes(key)),
            );
            // Identity-only upserts still need a RETURNING row without rewriting a PK.
            if (!Object.keys(patch).length)
              throw new CrudException('Upsert requires a mutable field', 400, 'VALIDATION_ERROR');
            const where = andAll(
              ...input.conflictTarget.map((key) => eq(getColumn(table, key), input.values[key])),
              buildWhere(table, input.scope ?? [], dialect),
            );
            if (config.driver === 'd1') {
              if (!db.batch)
                throw new CrudException('D1 batch unavailable', 500, 'CONFIGURATION_ERROR');
              const update = db
                .update(table)
                .set(patch)
                .where(andAll(where, sql`changes() = 0`))
                .returning();
              const result = await db.batch([checked(insert), checked(update)]);
              const created = result[0]?.[0],
                updated = result[1]?.[0];
              if (!created && !updated)
                throw new CrudException('Upsert scope denied', 403, 'FORBIDDEN');
              return { row: parseRow(created ?? updated), created: created !== undefined };
            }
            const created = (await insert)[0];
            if (created) return { row: parseRow(created), created: true };
            const updated = (await db.update(table).set(patch).where(where).returning())[0];
            if (!updated) throw new CrudException('Upsert scope denied', 403, 'FORBIDDEN');
            return { row: parseRow(updated), created: false };
          },
        }),
    requestScope,
    transaction,
    ...(!supportsAtomicBatch
      ? {}
      : {
          atomicBatch: atomicBatchDriver({
            owner: config.db,
            driver: config.driver,
            table,
            primaryKeys,
            where: (lookup) => lookupWhere(lookup, false),
            parse: parseRow,
            open: config.onOpenTransaction,
          }),
        }),

    async create(input, scope) {
      const db = handle(scope);
      try {
        if (dialect === 'mysql') {
          // mysql has no RETURNING: insert then re-select by PK (client-supplied)
          // or insertId (database-generated). Written per hono-crud; UNTESTED.
          const result = readRow(await db.insert(table).values(input));
          const pk = input[primaryKey] ?? result.insertId;
          const row = await selectOne(db, eq(pkColumn(), pk));
          if (!row) throw new Error('drizzleAdapter: created row not found after insert');
          return row;
        }
        const rows = await checked(db.insert(table).values(input).returning());
        const created = rows[0];
        if (!created) throw new Error('drizzleAdapter: insert returned no row');
        return parseRow(created);
      } catch (err) {
        rethrowMapped(err);
      }
    },

    async readOne(lookup, opts: ReadOptions, scope) {
      if (opts.forUpdate) {
        if (!capabilities.has('rowLocks'))
          throw new CrudException('Adapter cannot lock rows', 400, 'TRANSACTION_UNSUPPORTED');
        const db = handle(scope);
        if (scope.tx == null) throw new TypeError('Row locks require a transaction scope');
        if (dialect === 'pg' || dialect === 'mysql') {
          const rows = await db
            .select()
            .from(table)
            .where(lookupWhere(lookup, opts.withDeleted ?? false))
            .limit(1)
            .for('update');
          return rows[0] ? parseRow(rows[0]) : null;
        }
        // SQLite serializes writers at the transaction boundary.
      }
      return selectOne(handle(scope), lookupWhere(lookup, opts.withDeleted ?? false));
    },

    async update(lookup, patch, scope) {
      const db = handle(scope);
      const where = lookupWhere(lookup, false);
      if (dialect !== 'mysql') {
        try {
          const rows = await checked(db.update(table).set(patch).where(where).returning());
          return rows[0] ? parseRow(rows[0]) : null;
        } catch (err) {
          rethrowMapped(err);
        }
      }
      const existing = await selectOne(db, where);
      if (!existing) return null;
      try {
        await db.update(table).set(patch).where(where);
      } catch (err) {
        rethrowMapped(err);
      }
      return selectOne(db, eq(pkColumn(), existing[primaryKey]));
    },

    async delete(lookup, opts: DeleteOptions, scope) {
      const db = handle(scope);
      const where = lookupWhere(lookup, false);
      if (dialect !== 'mysql') {
        const rows =
          opts.softDeleteField !== undefined
            ? await checked(
                db
                  .update(table)
                  .set({ [opts.softDeleteField]: Date.now() })
                  .where(where)
                  .returning(),
              )
            : await checked(db.delete(table).where(where).returning());
        return rows[0] ? parseRow(rows[0]) : null;
      }
      const existing = await selectOne(db, where);
      if (!existing) return null;
      if (opts.softDeleteField !== undefined) {
        await db
          .update(table)
          .set({ [opts.softDeleteField]: Date.now() })
          .where(where);
        return selectOne(db, eq(pkColumn(), existing[primaryKey]));
      }
      await db.delete(table).where(where);
      return existing;
    },

    async restore(lookup, scope) {
      if (config.softDeleteField === undefined) return null;
      const db = handle(scope);
      if (dialect !== 'mysql') {
        const rows = await checked(
          db
            .update(table)
            .set({ [config.softDeleteField]: null })
            .where(
              andAll(
                lookupWhere(lookup, true),
                isNotNull(getColumn(table, config.softDeleteField)),
              ),
            )
            .returning(),
        );
        return rows[0] ? parseRow(rows[0]) : null;
      }
      // Deleted-aware lookup: match soft-deleted rows too.
      const existing = await selectOne(db, lookupWhere(lookup, true));
      if (!existing) return null;
      if (existing[config.softDeleteField] == null) return null; // not deleted
      await db
        .update(table)
        .set({ [config.softDeleteField]: null })
        .where(eq(pkColumn(), existing[primaryKey]));
      return selectOne(db, eq(pkColumn(), existing[primaryKey]));
    },

    async list(query: ListQuery, scope): Promise<Page<Row>> {
      const db = handle(scope);
      const { options } = query;
      const searchTerm = options.search;

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
                substringMatch(getColumn(table, field), searchTerm!, dialect),
              ),
            )
          : undefined;

      const where = andAll(buildWhere(table, query.filters, dialect), visibility, search);

      const countQuery = checked(
        db
          .select({ count: sql`count(*)` })
          .from(table)
          .where(where),
      );

      if (options.cursor !== undefined || (options.limit !== undefined && !options.keyset))
        throw new Error('Adapter cursors must be decoded by the engine');
      if (options.keyset) {
        const keyset = options.keyset;
        const limit = options.limit ?? options.per_page ?? 20;
        const after = keyset.after;
        const boundary =
          after === undefined
            ? undefined
            : orAll(
                ...keyset.fields.map((field, index) => {
                  const column = getColumn(table, field);
                  const value = after[index];
                  const comparison =
                    keyset.direction === 'asc'
                      ? value === null
                        ? isNotNull(column)
                        : gt(column, value)
                      : value === null
                        ? sql`false`
                        : orAll(lt(column, value), isNull(column));
                  return andAll(
                    ...keyset.fields
                      .slice(0, index)
                      .map((prefix, i) =>
                        after[i] === null
                          ? isNull(getColumn(table, prefix))
                          : eq(getColumn(table, prefix), after[i]),
                      ),
                    comparison,
                  );
                }),
              );
        const order = keyset.fields.flatMap((field) => {
          const column = getColumn(table, field);
          const sort = keyset.direction === 'asc' ? drizzleAsc : drizzleDesc;
          return [sort(sql`case when ${column} is null then 0 else 1 end`), sort(column)];
        });
        const pageQuery = checked(
          db
            .select()
            .from(table)
            .where(andAll(where, boundary))
            .orderBy(...order)
            .limit(limit + 1),
        );
        const countRows = await countQuery;
        const totalCount = Number(countRows[0]?.count) || 0;
        const rows = await pageQuery;
        return buildKeysetPage(limit, rows.map(parseRow), keyset, totalCount);
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
      const pageQuery = checked(builder.limit(perPage).offset((page - 1) * perPage));
      const countRows = await countQuery;
      const totalCount = Number(countRows[0]?.count) || 0;
      const rows = await pageQuery;
      const totalPages = Math.ceil(totalCount / perPage);
      return {
        result: rows.map(parseRow),
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
      const aggregations = spec.aggregations;
      for (const agg of aggregations) {
        const alias = agg.alias ?? deriveAlias(agg.operation, agg.field);
        assertSafeResultKey(alias, 'aggregate alias');
        if (Object.hasOwn(fields, alias)) {
          throw new Error(`drizzleAdapter: duplicate aggregate alias '${alias}'`);
        }
        fields[alias] = aggregateSql(table, agg.operation, agg.field);
      }
      const groupBy = spec.groupBy ?? [];
      for (const group of groupBy) {
        assertSafeResultKey(group, 'group field');
        if (Object.hasOwn(fields, group)) {
          throw new Error(
            `drizzleAdapter: group field '${group}' collides with an aggregate alias`,
          );
        }
        fields[group] = getColumn(table, group);
      }

      let builder = db.select(fields).from(table).where(where);
      if (groupBy.length > 0) {
        builder = builder.groupBy(...groupBy.map((g) => getColumn(table, g)));
      }
      const buckets = await checked(builder);
      const aliases = aggregations.map((agg) => agg.alias ?? deriveAlias(agg.operation, agg.field));

      if (groupBy.length === 0) {
        const first: Row = buckets[0] ?? {};
        const values: Record<string, number | null> = {};
        for (const alias of aliases) {
          const value = Object.hasOwn(first, alias) ? first[alias] : undefined;
          values[alias] = value == null ? null : Number(value);
        }
        return { values };
      }

      const groups = buckets.map((bucket) => {
        const key: Record<string, unknown> = {};
        for (const g of groupBy) key[g] = Object.hasOwn(bucket, g) ? bucket[g] : undefined;
        const values: Record<string, number | null> = {};
        for (const alias of aliases) {
          const value = Object.hasOwn(bucket, alias) ? bucket[alias] : undefined;
          values[alias] = value == null ? null : Number(value);
        }
        return { key, values };
      });
      return { groups, totalGroups: groups.length };
    },

    async updateWhere(filters: FilterCondition[], patch, scope): Promise<BulkOutcome<Row>> {
      const db = handle(scope);
      const visibility = softDeleteVisibility(false);
      const where = andAll(buildWhere(table, filters, dialect), visibility);
      if (dialect !== 'mysql') {
        try {
          const rows = await checked(db.update(table).set(patch).where(where).returning());
          return { count: rows.length, records: rows.map(parseRow) };
        } catch (err) {
          rethrowMapped(err);
        }
      }
      const matched = await db.select().from(table).where(where);
      if (matched.length === 0) return { count: 0, records: [] };
      try {
        await db.update(table).set(patch).where(where);
      } catch (err) {
        rethrowMapped(err);
      }
      const pks = matched.map((row) => row[primaryKey]);
      const updated = await db
        .select()
        .from(table)
        .where(orAll(...pks.map((pk) => eq(pkColumn(), pk))));
      return { count: updated.length, records: updated.map(parseRow) };
    },

    async createMany(rows, scope) {
      const db = handle(scope);
      if (rows.length === 0) return [];
      try {
        if (dialect === 'mysql') {
          // Per-row insert + re-select (no RETURNING). UNTESTED.
          const out: Row[] = [];
          for (const row of rows) {
            await db.insert(table).values(row);
            const pk = row[primaryKey];
            const created = await selectOne(db, eq(pkColumn(), pk));
            if (created) out.push(created);
          }
          return out;
        }
        return (await checked(db.insert(table).values(rows).returning())).map(parseRow);
      } catch (err) {
        rethrowMapped(err);
      }
    },

    ...(config.driver === 'd1' ? {} : { nested }),
    relations,
  });
}

function requireRelation(config: DrizzleAdapterConfig, relation: string): DrizzleRelation {
  const rel = config.relations?.[relation];
  if (!rel) {
    throw new Error(
      `drizzleAdapter: unknown relation '${relation}' — declare it in config.relations`,
    );
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
