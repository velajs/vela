/** Compile-time registry, native handle, resource model and async provider inference. */
import { expectTypeOf } from 'vitest';
import { defineProvider, InjectionToken } from '@velajs/vela';
import { z } from 'zod';
import { defineModel } from '../model/define-model';
import { defineCrudDatabase, createCrudDatabaseRegistry, databaseResource } from '../databases';
import { defineCrudFeature } from '../synthesize-controller';
import { testAdapter } from './test-adapter';

const model = defineModel({
  name: 'item',
  tableName: 'items',
  schema: z.object({ id: z.string(), count: z.number() }),
});
const native = { query: async (_sql: string) => [{ count: 1 }], engine: 'sql' as const };
const primary = defineCrudDatabase('primary', {
  handle: native,
  resources: { item: { model, adapter: testAdapter(new Map()) } },
});
const secondary = defineCrudDatabase('secondary', {
  handle: { cache: new Map<string, string>() },
  resources: { item: { model, adapter: testAdapter(new Map()) } },
});
const databases = createCrudDatabaseRegistry([primary, secondary], { defaultDatabase: 'primary' });
expectTypeOf(databases.get('primary').handle).toEqualTypeOf<typeof native>();
expectTypeOf(databases.get('secondary').handle.cache).toEqualTypeOf<Map<string, string>>();
const selection = databaseResource(primary, 'item');
expectTypeOf(selection.model).toEqualTypeOf<typeof model>();
expectTypeOf(selection.database).toEqualTypeOf<'primary'>();
defineCrudFeature({
  path: '/items',
  ...selection,
  hooks: {
    beforeCreate: (_context, row) => {
      if (row.count !== undefined) expectTypeOf(row.count).toEqualTypeOf<number>();
      return row;
    },
  },
});
function negatives() {
  // @ts-expect-error Unknown name is rejected by the typed registry.
  databases.get('unknown');
  // @ts-expect-error Resource keys retain their literal names.
  databaseResource(primary, 'missing');
  // @ts-expect-error Default selection must exist.
  createCrudDatabaseRegistry([primary, secondary], { defaultDatabase: 'missing' });
  // @ts-expect-error Native handles are not interchangeable across engines.
  const wrong: typeof native = databases.get('secondary').handle;
  return wrong;
}
void negatives;
const environment = new InjectionToken<{ database: typeof native }>('database-env');
const registryToken = new InjectionToken<typeof databases>('typed-databases');
defineProvider(registryToken, {
  inject: [environment],
  useFactory: async (env) => {
    expectTypeOf(env.database).toEqualTypeOf<typeof native>();
    return databases;
  },
});
defineProvider(new InjectionToken<typeof native>('native-database'), {
  inject: [registryToken],
  useFactory: async (registry) => registry.get('primary').handle,
});
