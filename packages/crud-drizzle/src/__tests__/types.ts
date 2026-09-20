/** Compile-time row inference and D1 capability discriminant regressions. */
import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { drizzleAdapter } from '../adapter';

const table = sqliteTable('typed', { id: text().primaryKey(), score: integer().notNull() });
const schema = z.object({ id: z.string(), score: z.number() });
function types(db: DrizzleD1Database, sqlite: LibSQLDatabase) {
  const adapter = drizzleAdapter({
    driver: 'd1',
    db,
    table,
    parseRow: (value) => schema.parse(value),
  });
  expectTypeOf<Awaited<ReturnType<typeof adapter.create>>>().toEqualTypeOf<
    z.infer<typeof schema>
  >();
  // @ts-expect-error D1 cannot initialize transaction-local state.
  drizzleAdapter({ driver: 'd1', db, table, onOpenTransaction: () => {} });
  // @ts-expect-error D1 is SQLite, never Postgres.
  drizzleAdapter({ driver: 'd1', dialect: 'pg', db, table });
  drizzleAdapter({ db: sqlite, table });
  return adapter.requestScope(async (scope) => {
    // @ts-expect-error Row inference is retained on write inputs.
    await adapter.create({ id: 'a', score: 'wrong' }, scope);
    const row = await adapter.readOne({ field: 'id', value: 'a' }, {}, scope);
    if (row) expectTypeOf(row.score).toEqualTypeOf<number>();
  });
}
void types;
