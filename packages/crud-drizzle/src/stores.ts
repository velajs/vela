/**
 * Drizzle-backed `VersioningStore` / `AuditStore` (hono-crud 0.13 storage
 * backend parity). The caller supplies the backing Drizzle table; the column
 * contract is documented on each store (see also the sqlite DDL helpers used
 * by the tests — consumers create the tables with their own migrations).
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { AuditEntry, AuditQuery, AuditStore } from '@velajs/crud/audit';
import {
  serializeVersionRecordKey,
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

  constructor(
    db: unknown,
    private readonly table: DrizzleTable,
  ) {
    this.db = asDatabase(db);
  }

  private col(name: string) {
    return getColumn(this.table, name);
  }

  async save(tableName: string, key: VersionRecordKey, entry: VersionEntry): Promise<void> {
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
  }

  async list(
    tableName: string,
    key: VersionRecordKey,
    options: { limit?: number; offset?: number } = {},
  ): Promise<VersionEntry[]> {
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

  constructor(
    db: unknown,
    private readonly table: DrizzleTable,
  ) {
    this.db = asDatabase(db);
    this.atomic = atomicAuditDriver(this.db, table);
  }

  private col(name: string) {
    return getColumn(this.table, name);
  }

  async log(entry: AuditEntry): Promise<void> {
    await this.db.insert(this.table).values({
      id: entry.id,
      timestamp: entry.timestamp.getTime(),
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
    for (const entry of entries) await this.log(entry);
  }

  async query(options: AuditQuery = {}): Promise<AuditEntry[]> {
    const conditions = [
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
      action: row.action as AuditEntry['action'],
      tableName: String(row.tableName),
      recordId: String(row.recordId),
      ...(row.userId != null ? { userId: String(row.userId) } : {}),
      ...(row.record != null ? { record: JSON.parse(String(row.record)) as Row } : {}),
      ...(row.previousRecord != null
        ? { previousRecord: JSON.parse(String(row.previousRecord)) as Row }
        : {}),
      ...(row.changes != null
        ? { changes: JSON.parse(String(row.changes)) as AuditEntry['changes'] }
        : {}),
      ...(row.metadata != null ? { metadata: JSON.parse(String(row.metadata)) as Row } : {}),
    }));
  }
}
