import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text as sqliteText,
  integer as sqliteInteger,
  primaryKey as sqlitePrimaryKey,
  index as sqliteIndex,
  check as sqliteCheck,
} from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  pgSchema,
  text as pgText,
  bigint,
  primaryKey as pgPrimaryKey,
  index as pgIndex,
  check as pgCheck,
  type PgTableFn,
} from 'drizzle-orm/pg-core';

function name(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,47}$/u.test(value))
    throw new TypeError('Expected a short lowercase SQL table/schema name');
  return value;
}
export function reliabilitySqliteTable(tableName = 'reliability') {
  name(tableName);
  return sqliteTable(
    tableName,
    {
      tenantId: sqliteText('tenant_id').notNull(),
      namespace: sqliteText().notNull(),
      kind: sqliteText().notNull(),
      id: sqliteText().notNull(),
      generation: sqliteText().notNull(),
      fingerprint: sqliteText().notNull(),
      payload: sqliteText().notNull(),
      state: sqliteText().notNull(),
      token: sqliteText(),
      fence: sqliteInteger().notNull(),
      revision: sqliteInteger().notNull(),
      attempt: sqliteInteger().notNull(),
      maxAttempts: sqliteInteger('max_attempts').notNull(),
      availableAt: sqliteInteger('available_at').notNull(),
      leaseUntil: sqliteInteger('lease_until'),
      createdAt: sqliteInteger('created_at').notNull(),
      updatedAt: sqliteInteger('updated_at').notNull(),
      retentionMs: sqliteInteger('retention_ms').notNull(),
      expiresAt: sqliteInteger('expires_at'),
      result: sqliteText(),
      error: sqliteText(),
    },
    (t) => [
      sqlitePrimaryKey({ columns: [t.tenantId, t.namespace, t.kind, t.id] }),
      sqliteIndex(`${tableName}_due`).on(t.tenantId, t.namespace, t.kind, t.state, t.availableAt),
      sqliteIndex(`${tableName}_expiry`).on(t.tenantId, t.namespace, t.kind, t.expiresAt),
      sqliteCheck(
        `${tableName}_state`,
        sql`${t.state} in ('pending','leased','completed','failed','cancelled')`,
      ),
      sqliteCheck(
        `${tableName}_attempts`,
        sql`${t.attempt} >= 0 and ${t.attempt} <= ${t.maxAttempts} and ${t.maxAttempts} between 1 and 1000`,
      ),
    ],
  );
}
export function reliabilityPgTable(tableName = 'reliability', schema?: string) {
  name(tableName);
  if (schema !== undefined) name(schema);
  const build = <S extends string | undefined>(table: PgTableFn<S>) =>
    table(
      tableName,
      {
        tenantId: pgText('tenant_id').notNull(),
        namespace: pgText().notNull(),
        kind: pgText().notNull(),
        id: pgText().notNull(),
        generation: pgText().notNull(),
        fingerprint: pgText().notNull(),
        payload: pgText().notNull(),
        state: pgText().notNull(),
        token: pgText(),
        fence: bigint({ mode: 'number' }).notNull(),
        revision: bigint({ mode: 'number' }).notNull(),
        attempt: bigint({ mode: 'number' }).notNull(),
        maxAttempts: bigint('max_attempts', { mode: 'number' }).notNull(),
        availableAt: bigint('available_at', { mode: 'number' }).notNull(),
        leaseUntil: bigint('lease_until', { mode: 'number' }),
        createdAt: bigint('created_at', { mode: 'number' }).notNull(),
        updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
        retentionMs: bigint('retention_ms', { mode: 'number' }).notNull(),
        expiresAt: bigint('expires_at', { mode: 'number' }),
        result: pgText(),
        error: pgText(),
      },
      (t) => [
        pgPrimaryKey({ columns: [t.tenantId, t.namespace, t.kind, t.id] }),
        pgIndex(`${tableName}_due`).on(t.tenantId, t.namespace, t.kind, t.state, t.availableAt),
        pgIndex(`${tableName}_expiry`).on(t.tenantId, t.namespace, t.kind, t.expiresAt),
        pgCheck(
          `${tableName}_state`,
          sql`${t.state} in ('pending','leased','completed','failed','cancelled')`,
        ),
        pgCheck(
          `${tableName}_attempts`,
          sql`${t.attempt} >= 0 and ${t.attempt} <= ${t.maxAttempts} and ${t.maxAttempts} between 1 and 1000`,
        ),
      ],
    );
  return schema === undefined ? build(pgTable) : build(pgSchema(schema).table);
}
