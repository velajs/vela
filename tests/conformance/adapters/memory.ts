/**
 * Memory adapter leg: in-process store, reset via `clearMemoryStorage()`.
 *
 * ONE Vela app hosts both route families (mirroring hono-crud's single-app
 * descriptor):
 * - `/items`        — the base conformance model (group-1 cells).
 * - `/tenant-items` — the tenant-scoped model + owner-scoped `parent` relation
 *                     (tenant-scoping + relation-scoping cells).
 *
 * The `multiTenant()` resolver must run UPSTREAM of Vela's routes (Vela builds
 * its routes at `VelaFactory.create()` time). We wrap the Vela app in an outer
 * Hono that mounts the resolver PATH-SCOPED to `/tenant-items` (so the
 * non-tenant `/items` cells never need a header) and `.route('/')`s the Vela
 * app underneath — the resolver's `c.set('tenantId', ...)` var propagates into
 * the mounted app. The outer app also renders a middleware-thrown
 * `CrudException` (Vela's `HttpException` is not a Hono `HTTPException`, so a
 * plain outer Hono would otherwise swallow the TENANT_REQUIRED throw).
 *
 * Lifecycle: the app is built ONCE per suite (in `setup`); DATA is reset
 * between tests via `clearMemoryStorage()` (mirrors hono-crud's memory leg,
 * which wipes the module-level store rather than re-mounting the app).
 *
 * Capabilities:
 * - uniqueConstraints: false — no constraint surface (unique-conflict deferred).
 * - timestampKind: epoch-ms — library-managed (`Model.timestamps: true`).
 * - relationScoping: true — the tenant model carries the `parent` self-relation.
 */
import { Hono } from 'hono';
import { Controller, Module, VelaFactory } from '@velajs/vela';
import { Crud, CrudException, multiTenant } from '@velajs/crud';
import { clearMemoryStorage, memoryAdapter } from '@velajs/crud-memory';
import type { AdapterContext, AdapterDescriptor } from '../contract';
import {
  CONFORMANCE_FILTER_CONFIG,
  CONFORMANCE_SORT_FIELDS,
  CONFORMANCE_TABLE,
  CONFORMANCE_TENANT_TABLE,
  conformanceModel,
  tenantModel,
} from '../model';

async function setup(): Promise<AdapterContext> {
  clearMemoryStorage();

  const itemAdapter = memoryAdapter({
    tableName: CONFORMANCE_TABLE,
    primaryKey: 'id',
    softDeleteField: 'deletedAt',
  });

  const tenantAdapter = memoryAdapter({
    tableName: CONFORMANCE_TENANT_TABLE,
    primaryKey: 'id',
    softDeleteField: 'deletedAt',
    relations: {
      parent: {
        type: 'belongsTo',
        table: CONFORMANCE_TENANT_TABLE,
        foreignKey: 'parentId',
        localKey: 'id',
      },
    },
  });

  @Controller('/items')
  @Crud({
    model: conformanceModel,
    adapter: itemAdapter,
    filterConfig: CONFORMANCE_FILTER_CONFIG,
    sortFields: CONFORMANCE_SORT_FIELDS,
  })
  class ItemsController {}

  @Controller('/tenant-items')
  @Crud({
    model: tenantModel,
    adapter: tenantAdapter,
    tenantResolverMounted: true,
    allowedIncludes: ['parent'],
  })
  class TenantItemsController {}

  @Module({ controllers: [ItemsController, TenantItemsController] })
  class AppModule {}

  const app = await VelaFactory.create(AppModule);

  // Mount the tenant resolver upstream (path-scoped) and render its throws.
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
  outer.use('/tenant-items', multiTenant());
  outer.use('/tenant-items/*', multiTenant());
  outer.route('/', app.getHonoApp());

  return {
    app: { request: (path, init) => outer.request(path, init) },
    reset: () => {
      clearMemoryStorage();
    },
  };
}

export const memoryConformance: AdapterDescriptor = {
  name: 'memory',
  capabilities: {
    uniqueConstraints: false,
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
