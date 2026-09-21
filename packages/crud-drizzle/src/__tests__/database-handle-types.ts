import { expectTypeOf } from 'vitest';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type {
  MySqlDatabase,
  MySqlQueryResultHKT,
  PreparedQueryHKTBase,
} from 'drizzle-orm/mysql-core';
import { pgTable, text as pgText } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { defineCrudDatabase, createCrudDatabaseRegistry, defineModel } from '@velajs/crud';
import { drizzleAdapter } from '../adapter';

const sqliteTableDef = sqliteTable('items', { id: text().primaryKey() });
const pgTableDef = pgTable('items', { id: pgText().primaryKey() });
const mysqlTableDef = mysqlTable('items', { id: varchar({ length: 64 }).primaryKey() });
const schema = z.object({ id: z.string() });
const model = defineModel({ name: 'item', tableName: 'items', schema });
function inference(
  sqlite: LibSQLDatabase<{ items: typeof sqliteTableDef }>,
  pg: PgDatabase<PgQueryResultHKT, { items: typeof pgTableDef }>,
  mysql: MySqlDatabase<MySqlQueryResultHKT, PreparedQueryHKTBase, { items: typeof mysqlTableDef }>,
) {
  const sqliteAdapter = drizzleAdapter({
    db: sqlite,
    table: sqliteTableDef,
    parseRow: (value) => schema.parse(value),
  });
  const pgAdapter = drizzleAdapter({
    db: pg,
    dialect: 'pg',
    table: pgTableDef,
    parseRow: (value) => schema.parse(value),
  });
  const mysqlAdapter = drizzleAdapter({
    db: mysql,
    dialect: 'mysql',
    table: mysqlTableDef,
    parseRow: (value) => schema.parse(value),
  });
  const registry = createCrudDatabaseRegistry([
    defineCrudDatabase('sqlite', {
      handle: sqlite,
      resources: { item: { model, adapter: sqliteAdapter } },
    }),
    defineCrudDatabase('pg', { handle: pg, resources: { item: { model, adapter: pgAdapter } } }),
    defineCrudDatabase('mysql', {
      handle: mysql,
      resources: { item: { model, adapter: mysqlAdapter } },
    }),
  ]);
  expectTypeOf(registry.get('sqlite').handle).toEqualTypeOf<typeof sqlite>();
  expectTypeOf(registry.get('pg').handle).toEqualTypeOf<typeof pg>();
  expectTypeOf(registry.get('mysql').handle).toEqualTypeOf<typeof mysql>();
  expectTypeOf<Awaited<ReturnType<typeof sqliteAdapter.create>>>().toEqualTypeOf<{ id: string }>();
  // @ts-expect-error Selecting another database does not erase its native engine type.
  const wrong: typeof pg = registry.get('sqlite').handle;
  // @ts-expect-error A missing database is not a valid registry key.
  registry.get('other');
  return wrong;
}
void inference;
