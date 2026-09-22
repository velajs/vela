/**
 * Drizzle-backed `VersioningStore` / `AuditStore` (hono-crud 0.13 storage
 * backend parity). The caller supplies the backing Drizzle table; the column
 * contract is documented on each store (see also the sqlite DDL helpers used
 * by the tests — consumers create the tables with their own migrations).
 */

import { and, desc, eq, sql, gte, lte, is } from 'drizzle-orm';
import {
  parseAuditAction,
  validateAuditEntry,
  validateAuditQuery,
  type AuditEntry,
  type AuditQuery,
  type AuditStore,
} from '@velajs/crud/audit';
import { PgTable, getTableConfig as pgTableConfig } from 'drizzle-orm/pg-core';
import { SQLiteTable, getTableConfig as sqliteTableConfig } from 'drizzle-orm/sqlite-core';
import { drizzleTransactionStore } from './transaction';
import {
  serializeVersionRecordKey,
  historyNamespaceFor,
  validateHistoryPagination,
  validateVersionNumber,
  validateVersionEntry,
  VersionConflictError,
  type VersionEntry,
  type VersioningStore,
  type VersionRecordKey,
} from '@velajs/crud/versioning';
import { asDatabase, type DrizzleDatabase, type DrizzleTable } from './database';
import { getColumn } from './filters';
import { atomicAuditDriver } from './atomic';

type Row = Record<string, unknown>;

/**
 * Column contract: id (text pk), tableName (text), recordId (text v2 scoped key),
 * version (integer), data (text json), createdAt (integer epoch-ms),
 * changedBy (text null), changeReason (text null).
 */
export class DrizzleVersioningStore implements VersioningStore {
  private readonly db: DrizzleDatabase;
  readonly transaction?: NonNullable<VersioningStore['transaction']>;

  constructor(
    db: unknown,
    private readonly table: DrizzleTable,
  ) {
    this.db = asDatabase(db);
    assertVersionUniqueness(table);
    if (supportsHistoryTransactions(db, table))
      this.transaction = drizzleTransactionStore(this.db, (run, context) => {
        const keyInScope = (key: VersionRecordKey) => {
          if (key.tenantNamespace !== historyNamespaceFor(context))
            throw new TypeError('Version transaction tenant mismatch');
          return key;
        };
        return {
          validatePersistence: () =>
            run((native) => new DrizzleVersioningStore(native, table).validatePersistence()),
          save: (name, key, entry) =>
            run((native) =>
              new DrizzleVersioningStore(native, table).save(name, keyInScope(key), entry),
            ),
          list: (name, key, options) =>
            run((native) =>
              new DrizzleVersioningStore(native, table).list(name, keyInScope(key), options),
            ),
          get: (name, key, version) =>
            run((native) =>
              new DrizzleVersioningStore(native, table).get(name, keyInScope(key), version),
            ),
          latest: (name, key) =>
            run((native) =>
              new DrizzleVersioningStore(native, table).latest(name, keyInScope(key)),
            ),
          deleteAll: (name, key) =>
            run((native) =>
              new DrizzleVersioningStore(native, table).deleteAll(name, keyInScope(key)),
            ),
        };
      });
  }

  async validatePersistence(): Promise<void> {
    const columns = ['tableName', 'recordId', 'version'].map((name) => this.col(name).name).sort();
    let valid;
    if (is(this.table, PgTable)) {
      const config = pgTableConfig(this.table);
      const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
      const name = config.schema
        ? `${quote(config.schema)}.${quote(config.name)}`
        : quote(config.name);
      valid = sql`exists (
        select 1 from pg_index i where i.indrelid = to_regclass(${name})
        and i.indisunique and i.indisvalid and i.indimmediate and i.indpred is null and i.indexprs is null
        and i.indnkeyatts = 3 and (
          select array_agg(a.attname::text order by a.attname) from unnest(i.indkey) with ordinality k(attnum, pos)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum where k.pos <= i.indnkeyatts
        ) = array[${columns[0]}, ${columns[1]}, ${columns[2]}]::text[]
      )`;
    } else if (is(this.table, SQLiteTable)) {
      const name = sqliteTableConfig(this.table).name;
      valid = sql`exists (
        select 1 from pragma_index_list(${name}) i where i."unique" = 1 and i.partial = 0
        and (select count(*) from pragma_index_info(i.name)) = 3
        and not exists (select 1 from pragma_index_info(i.name) c
          where c.name is null or c.name not in (${columns[0]}, ${columns[1]}, ${columns[2]}))
      )`;
    } else throw new TypeError('Version history requires SQLite or PostgreSQL');
    const rows = await this.db.select({ valid }).from(sql`(select 1) as history_constraint_check`);
    if (rows[0]?.valid !== true && rows[0]?.valid !== 1)
      throw new TypeError(
        'Missing physical UNIQUE(tableName, recordId, version) history constraint',
      );
  }

  private col(name: string) {
    return getColumn(this.table, name);
  }

  async save(tableName: string, key: VersionRecordKey, entry: VersionEntry): Promise<void> {
    await this.validatePersistence();
    validateVersionEntry(entry);
    try {
      await this.db.insert(this.table).values({
        id: entry.id,
        tableName,
        recordId: serializeVersionRecordKey(key),
        version: entry.version,
        data: JSON.stringify({
          __velaVersionEntry: 2,
          recordId: entry.recordId,
          data: entry.data,
        }),
        createdAt: entry.createdAt.getTime(),
        changedBy: entry.changedBy ?? null,
        changeReason: entry.changeReason ?? null,
      });
    } catch (error) {
      if (isVersionConflict(error)) throw new VersionConflictError({ cause: error });
      throw error;
    }
  }

  async list(
    tableName: string,
    key: VersionRecordKey,
    options: { limit?: number; offset?: number } = {},
  ): Promise<VersionEntry[]> {
    validateHistoryPagination(options);
    let builder = this.db
      .select()
      .from(this.table)
      .where(
        and(
          eq(this.col('tableName'), tableName),
          eq(this.col('recordId'), serializeVersionRecordKey(key)),
        ),
      )
      .orderBy(desc(this.col('version')));
    if (options.limit !== undefined) builder = builder.limit(options.limit);
    if (options.offset !== undefined) builder = builder.offset(options.offset);
    const rows = (await builder) as Row[];
    return rows.map((row) => this.toEntry(row));
  }

  async get(
    tableName: string,
    key: VersionRecordKey,
    version: number,
  ): Promise<VersionEntry | null> {
    validateVersionNumber(version);
    const rows = (await this.db
      .select()
      .from(this.table)
      .where(
        and(
          eq(this.col('tableName'), tableName),
          eq(this.col('recordId'), serializeVersionRecordKey(key)),
          eq(this.col('version'), version),
        ),
      )
      .limit(1)) as Row[];
    return rows[0] ? this.toEntry(rows[0]) : null;
  }

  async latest(tableName: string, key: VersionRecordKey): Promise<number> {
    const rows = (await this.db
      .select({ latest: sql`max(${this.col('version')})` })
      .from(this.table)
      .where(
        and(
          eq(this.col('tableName'), tableName),
          eq(this.col('recordId'), serializeVersionRecordKey(key)),
        ),
      )) as Array<{ latest: unknown }>;
    return Number(rows[0]?.latest) || 0;
  }

  async deleteAll(tableName: string, key: VersionRecordKey): Promise<number> {
    const existing = await this.list(tableName, key);
    await this.db
      .delete(this.table)
      .where(
        and(
          eq(this.col('tableName'), tableName),
          eq(this.col('recordId'), serializeVersionRecordKey(key)),
        ),
      );
    return existing.length;
  }

  private toEntry(row: Row): VersionEntry {
    const stored = JSON.parse(String(row.data)) as unknown;
    if (
      typeof stored !== 'object' ||
      stored === null ||
      Array.isArray(stored) ||
      (stored as Row).__velaVersionEntry !== 2 ||
      !Object.hasOwn(stored, 'data') ||
      (typeof (stored as Row).recordId !== 'string' &&
        typeof (stored as Row).recordId !== 'number') ||
      typeof (stored as Row).data !== 'object' ||
      (stored as Row).data === null ||
      Array.isArray((stored as Row).data)
    ) {
      throw new Error('invalid or legacy unscoped version entry');
    }
    const envelope = stored as { recordId: string | number; data: Record<string, unknown> };
    return {
      id: String(row.id),
      recordId: envelope.recordId,
      version: Number(row.version),
      data: envelope.data,
      createdAt: new Date(Number(row.createdAt)),
      ...(row.changedBy != null ? { changedBy: String(row.changedBy) } : {}),
      ...(row.changeReason != null ? { changeReason: String(row.changeReason) } : {}),
    };
  }
}

/**
 * Column contract: id (text pk), timestamp (integer epoch-ms), action (text),
 * tableName (text), recordId (text), userId (text null), record (text json
 * null), previousRecord (text json null), changes (text json null),
 * metadata (text json null).
 */
export class DrizzleAuditStore implements AuditStore {
  private readonly db: DrizzleDatabase;
  readonly atomic: import('@velajs/crud/audit').AtomicAuditDriver;
  readonly transaction?: NonNullable<AuditStore['transaction']>;

  constructor(
    db: unknown,
    private readonly table: DrizzleTable,
  ) {
    this.db = asDatabase(db);
    getColumn(table, 'tenantNamespace');
    this.atomic = atomicAuditDriver(this.db, table);
    if (supportsHistoryTransactions(db, table))
      this.transaction = drizzleTransactionStore(this.db, (run, context) => {
        const namespace = historyNamespaceFor(context);
        const scoped = <T extends { tenantNamespace?: string }>(
          value: T,
        ): T & { tenantNamespace: string } => {
          if (value.tenantNamespace !== undefined && value.tenantNamespace !== namespace)
            throw new TypeError('Audit transaction tenant mismatch');
          return { ...value, tenantNamespace: namespace };
        };
        return {
          validatePersistence: () =>
            run((native) => new DrizzleAuditStore(native, table).validatePersistence()),
          log: (entry) => run((native) => new DrizzleAuditStore(native, table).log(scoped(entry))),
          logBatch: (entries) =>
            run((native) => new DrizzleAuditStore(native, table).logBatch(entries.map(scoped))),
          query: (options = {}) =>
            run((native) => new DrizzleAuditStore(native, table).query(scoped(options))),
        };
      });
  }

  private col(name: string) {
    return getColumn(this.table, name);
  }

  async validatePersistence(): Promise<void> {
    await this.db.select().from(this.table).limit(0);
  }

  async log(entry: AuditEntry): Promise<void> {
    validateAuditEntry(entry);
    await this.db.insert(this.table).values({
      id: entry.id,
      timestamp: entry.timestamp.getTime(),
      tenantNamespace: entry.tenantNamespace ?? 'global',
      action: entry.action,
      tableName: entry.tableName,
      recordId: String(entry.recordId),
      userId: entry.userId ?? null,
      record: entry.record !== undefined ? JSON.stringify(entry.record) : null,
      previousRecord:
        entry.previousRecord !== undefined ? JSON.stringify(entry.previousRecord) : null,
      changes: entry.changes !== undefined ? JSON.stringify(entry.changes) : null,
      metadata: entry.metadata !== undefined ? JSON.stringify(entry.metadata) : null,
    });
  }

  async logBatch(entries: AuditEntry[]): Promise<void> {
    entries.forEach(validateAuditEntry);
    for (const entry of entries) await this.log(entry);
  }

  async query(options: AuditQuery = {}): Promise<AuditEntry[]> {
    validateAuditQuery(options);
    const conditions = [
      eq(this.col('tenantNamespace'), options.tenantNamespace ?? 'global'),
      options.startDate !== undefined
        ? gte(this.col('timestamp'), options.startDate.getTime())
        : undefined,
      options.endDate !== undefined
        ? lte(this.col('timestamp'), options.endDate.getTime())
        : undefined,
      options.tableName !== undefined ? eq(this.col('tableName'), options.tableName) : undefined,
      options.recordId !== undefined
        ? eq(this.col('recordId'), String(options.recordId))
        : undefined,
      options.action !== undefined ? eq(this.col('action'), options.action) : undefined,
      options.userId !== undefined ? eq(this.col('userId'), options.userId) : undefined,
    ].filter((c) => c !== undefined);

    let builder = this.db
      .select()
      .from(this.table)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(this.col('timestamp')));
    if (options.limit !== undefined) builder = builder.limit(options.limit);
    if (options.offset !== undefined) builder = builder.offset(options.offset);
    const rows = (await builder) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      timestamp: new Date(Number(row.timestamp)),
      tenantNamespace: String(row.tenantNamespace),
      action: parseAuditAction(row.action),
      tableName: String(row.tableName),
      recordId: String(row.recordId),
      ...(row.userId != null ? { userId: String(row.userId) } : {}),
      ...(row.record != null ? { record: parseRecord(row.record) } : {}),
      ...(row.previousRecord != null ? { previousRecord: parseRecord(row.previousRecord) } : {}),
      ...(row.changes != null ? { changes: parseChanges(row.changes) } : {}),
      ...(row.metadata != null ? { metadata: parseRecord(row.metadata) } : {}),
    }));
  }
}

function supportsHistoryTransactions(db: unknown, table: DrizzleTable): boolean {
  return (
    is(table, PgTable) ||
    (is(table, SQLiteTable) &&
      typeof db === 'object' &&
      db !== null &&
      'resultKind' in db &&
      db.resultKind === 'async')
  );
}

/** Metadata must agree with the migrated physical uniqueness constraint. */
function assertVersionUniqueness(table: DrizzleTable): void {
  const config = is(table, PgTable)
    ? pgTableConfig(table)
    : is(table, SQLiteTable)
      ? sqliteTableConfig(table)
      : undefined;
  if (!config) throw new TypeError('Version history requires SQLite or PostgreSQL');
  const expected = ['tableName', 'recordId', 'version']
    .map((name) => getColumn(table, name).name)
    .sort();
  const constraints = [
    ...config.uniqueConstraints.map((constraint) => constraint.columns),
    ...config.primaryKeys.map((constraint) => constraint.columns),
    ...config.indexes
      .filter((index) => index.config.unique && !index.config.where)
      .map((index) => index.config.columns),
  ];
  if (
    !constraints.some(
      (columns) =>
        columns.length === 3 &&
        columns
          .map((column) => ('name' in column ? column.name : undefined))
          .sort()
          .every((name, index) => name === expected[index]),
    )
  )
    throw new TypeError('Version history requires UNIQUE(tableName, recordId, version)');
}

function parseRecord(value: unknown): Row {
  const parsed: unknown = JSON.parse(String(value));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new TypeError('Invalid audit record');
  return Object.fromEntries(Object.entries(parsed));
}
function parseChanges(value: unknown): NonNullable<AuditEntry['changes']> {
  const parsed: unknown = JSON.parse(String(value));
  if (!Array.isArray(parsed)) throw new TypeError('Invalid audit changes');
  return parsed.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('field' in entry) ||
      typeof entry.field !== 'string'
    )
      throw new TypeError('Invalid audit field change');
    return {
      field: entry.field,
      ...('oldValue' in entry ? { oldValue: entry.oldValue } : {}),
      ...('newValue' in entry ? { newValue: entry.newValue } : {}),
    };
  });
}

function isVersionConflict(error: unknown): boolean {
  const seen = new Set<object>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    if (
      'code' in error &&
      (error.code === '23505' ||
        error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY')
    )
      return true;
    if ('rawCode' in error && (error.rawCode === 2067 || error.rawCode === 1555)) return true;
    error = 'cause' in error ? error.cause : undefined;
  }
  return false;
}
