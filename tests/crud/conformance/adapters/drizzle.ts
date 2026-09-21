/**
 * Drizzle adapter leg: file-backed libsql (sqlite) database — libsql
 * transactions open a fresh connection, so `:memory:` would give the tx a
 * DIFFERENT empty db (the hono-crud caveat). Mirrors the memory descriptor:
 * one Vela app hosting /items, /tenant-items (resolver mounted upstream), and
 * /cursor-items; the app is built once per suite and `reset()` deletes all
 * rows between tests.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Controller, Module, VelaFactory } from '@velajs/vela';
import { ALL_CRUD_ENDPOINTS, Crud, CrudException, multiTenant } from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import type { AdapterContext, AdapterDescriptor } from '../contract';
import {
  CONFORMANCE_FILTER_CONFIG,
  CONFORMANCE_SORT_FIELDS,
  conformanceModel,
  cursorModel,
  etagModel,
  serializationModel,
  tenantModel,
  uniqueModel,
} from '../model';

const UPSERT_KEYS = ['email'];

const baseColumns = {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  role: text('role').notNull(),
  age: integer('age'),
  deletedAt: integer('deletedAt'),
  createdAt: integer('createdAt'),
  updatedAt: integer('updatedAt'),
};

const itemsTable = sqliteTable('conformance_items', baseColumns);
const tenantTable = sqliteTable('conformance_tenant_items', {
  ...baseColumns,
  tenantId: text('tenantId'),
  parentId: text('parentId'),
});
const cursorTable = sqliteTable('conformance_cursor_items', baseColumns);
const profileTable = sqliteTable('conformance_profile_items', {
  ...baseColumns,
  parentId: text('parentId'),
});
const uniqueTable = sqliteTable('conformance_unique_items', baseColumns);
const etagTable = sqliteTable('conformance_etag_items', baseColumns);

const BASE_DDL =
  'id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, ' +
  'age INTEGER, deletedAt INTEGER, createdAt INTEGER, updatedAt INTEGER';

async function setup(): Promise<AdapterContext> {
  const dir = mkdtempSync(join(tmpdir(), 'crud-conformance-drizzle-'));
  const client = createClient({ url: `file:${join(dir, 'conformance.db')}` });
  const db = drizzle(client);

  try {
    await client.execute(`CREATE TABLE conformance_items (${BASE_DDL})`);
    await client.execute(
      `CREATE TABLE conformance_tenant_items (${BASE_DDL}, tenantId TEXT, parentId TEXT)`,
    );
    await client.execute(`CREATE TABLE conformance_cursor_items (${BASE_DDL})`);
    await client.execute(`CREATE TABLE conformance_profile_items (${BASE_DDL}, parentId TEXT)`);
    // The unique leg enforces via a real database constraint (adapter maps the
    // driver violation to 409 ConflictException).
    await client.execute(`CREATE TABLE conformance_unique_items (${BASE_DDL}, UNIQUE(email))`);
    await client.execute(`CREATE TABLE conformance_etag_items (${BASE_DDL})`);

    const itemAdapter = drizzleAdapter({
      db,
      dialect: 'sqlite',
      table: itemsTable,
      softDeleteField: 'deletedAt',
    });
    const tenantAdapter = drizzleAdapter({
      db,
      dialect: 'sqlite',
      table: tenantTable,
      softDeleteField: 'deletedAt',
      relations: {
        parent: { type: 'belongsTo', table: tenantTable, foreignKey: 'parentId', localKey: 'id' },
      },
    });
    const cursorAdapter = drizzleAdapter({
      db,
      dialect: 'sqlite',
      table: cursorTable,
      softDeleteField: 'deletedAt',
    });
    const profileAdapter = drizzleAdapter({
      db,
      dialect: 'sqlite',
      table: profileTable,
      softDeleteField: 'deletedAt',
      relations: {
        parent: { type: 'belongsTo', table: profileTable, foreignKey: 'parentId', localKey: 'id' },
      },
    });

    @Controller('/items')
    @Crud({
      model: conformanceModel,
      adapter: itemAdapter,
      only: ALL_CRUD_ENDPOINTS,
      filterConfig: CONFORMANCE_FILTER_CONFIG,
      sortFields: CONFORMANCE_SORT_FIELDS,
      upsert: { keys: UPSERT_KEYS },
    })
    class ItemsController {}

    @Controller('/tenant-items')
    @Crud({
      model: tenantModel,
      adapter: tenantAdapter,
      only: ALL_CRUD_ENDPOINTS,
      tenantResolverMounted: true,
      allowedIncludes: ['parent'],
      filterConfig: CONFORMANCE_FILTER_CONFIG,
      sortFields: CONFORMANCE_SORT_FIELDS,
      searchFields: ['name'],
      aggregate: { groupByFields: ['role'] },
      upsert: { keys: UPSERT_KEYS },
    })
    class TenantItemsController {}

    @Controller('/cursor-items')
    @Crud({
      model: cursorModel,
      adapter: cursorAdapter,
      sortFields: CONFORMANCE_SORT_FIELDS,
      pagination: { cursor: { enabled: true, field: 'id' } },
    })
    class CursorItemsController {}

    const uniqueAdapter = drizzleAdapter({
      db,
      dialect: 'sqlite',
      table: uniqueTable,
      softDeleteField: 'deletedAt',
    });
    const etagAdapter = drizzleAdapter({
      db,
      dialect: 'sqlite',
      table: etagTable,
      softDeleteField: 'deletedAt',
    });

    @Controller('/unique-items')
    @Crud({ model: uniqueModel, adapter: uniqueAdapter })
    class UniqueItemsController {}

    @Controller('/etag-items')
    @Crud({ model: etagModel, adapter: etagAdapter, etag: true })
    class EtagItemsController {}

    @Controller('/profile-items')
    @Crud({
      model: serializationModel,
      adapter: profileAdapter,
      only: ALL_CRUD_ENDPOINTS,
      filterConfig: CONFORMANCE_FILTER_CONFIG,
      sortFields: CONFORMANCE_SORT_FIELDS,
      searchFields: ['name'],
      upsert: { keys: UPSERT_KEYS },
      fieldSelection: { enabled: true },
      allowedIncludes: ['parent'],
    })
    class ProfileItemsController {}

    @Module({
      controllers: [
        ItemsController,
        TenantItemsController,
        CursorItemsController,
        ProfileItemsController,
        UniqueItemsController,
        EtagItemsController,
      ],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    const outer = new Hono();
    outer.onError((err, c) => {
      if (err instanceof CrudException) {
        return c.json(err.getResponse() as Record<string, unknown>, err.getStatus() as never);
      }
      return c.json(
        { success: false, error: { code: 'INTERNAL_ERROR', message: String(err) } },
        500,
      );
    });
    outer.use('/tenant-items', multiTenant({ validate: () => true }));
    outer.use('/tenant-items/*', multiTenant({ validate: () => true }));
    outer.route('/', app.getHonoApp());

    return {
      app: { request: async (path, init) => outer.request(path, init) },
      teardown: async () => {
        try {
          await app.dispose();
        } finally {
          client.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      reset: async () => {
        await client.execute('DELETE FROM conformance_items');
        await client.execute('DELETE FROM conformance_tenant_items');
        await client.execute('DELETE FROM conformance_cursor_items');
        await client.execute('DELETE FROM conformance_profile_items');
        await client.execute('DELETE FROM conformance_unique_items');
        await client.execute('DELETE FROM conformance_etag_items');
      },
    };
  } catch (error) {
    client.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export const drizzleConformance: AdapterDescriptor = {
  name: 'drizzle',
  capabilities: {
    uniqueConstraints: true,
    timestampKind: 'epoch-ms',
    relationScoping: true,
  },
  tenant: {
    field: 'tenantId',
    headerName: 'X-Tenant-ID',
    tenantA: 'tenant-a',
    tenantB: 'tenant-b',
  },
  setup,
};
