import { ENV, Module, type VelaEnv } from '@velajs/vela';
import { drizzle } from 'drizzle-orm/d1';
import {
  CrudModule,
  defineCrudFeature,
  defineCrudDatabase,
  createCrudDatabaseRegistry,
} from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import { items, itemModel, itemSchema } from './schema.js';

// PRIMARY_DB and ANALYTICS_DB are typed by worker-configuration.d.ts (`pnpm types`).
export function createDatabases(env: VelaEnv) {
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

/**
 * Declared once. The CRUD factory builds both databases from each native
 * environment, and each resource selects its database by name.
 */
@Module({
  imports: [
    CrudModule.forRootAsync({
      inject: [ENV],
      useFactory: (env) => ({ databases: createDatabases(env) }),
    }),
    CrudModule.forFeature([
      defineCrudFeature({ path: '/primary/items', model: itemModel, database: 'primary' }),
      defineCrudFeature({ path: '/analytics/items', model: itemModel, database: 'analytics' }),
    ]),
  ],
})
export class AppModule {}
