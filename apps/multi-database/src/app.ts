import { Module } from '@velajs/vela';
import { drizzle } from 'drizzle-orm/d1';
import {
  CrudModule,
  defineCrudFeature,
  defineCrudDatabase,
  createCrudDatabaseRegistry,
  databaseResource,
} from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import { items, itemModel, itemSchema } from './schema.js';

export interface Env {
  PRIMARY_DB: D1Database;
  ANALYTICS_DB: D1Database;
}

export function createDatabases(env: Env) {
  const primary = drizzle(env.PRIMARY_DB, { schema: { items } });
  const analytics = drizzle(env.ANALYTICS_DB, { schema: { items } });
  const resource = (db: typeof primary) => ({
    item: {
      model: itemModel,
      adapter: drizzleAdapter({
        driver: 'd1',
        db,
        table: items,
        parseRow: (value: unknown) => itemSchema.parse(value),
      }),
    },
  });
  return createCrudDatabaseRegistry(
    [
      defineCrudDatabase('primary', { handle: primary, resources: resource(primary) }),
      defineCrudDatabase('analytics', { handle: analytics, resources: resource(analytics) }),
    ],
    { defaultDatabase: 'primary' },
  );
}

/** The Cloudflare factory builds this graph once for each native environment. */
export function createAppModule(env: Env) {
  const databases = createDatabases(env);
  class AppModule {}
  Module({
    imports: [
      CrudModule.forRootAsync({ inject: [], useFactory: async () => ({ databases }) }),
      CrudModule.forFeature([
        defineCrudFeature({
          path: '/primary/items',
          ...databaseResource(databases.get('primary'), 'item'),
        }),
        defineCrudFeature({
          path: '/analytics/items',
          ...databaseResource(databases.get('analytics'), 'item'),
        }),
      ]),
    ],
  })(AppModule);
  return AppModule;
}
