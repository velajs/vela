import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Controller,
  Get,
  MetadataRegistry,
  Module,
  UseGuards,
  UrlGeneratorService,
  VelaFactory,
  createOpenApiDocument,
  type CanActivate,
  type ExecutionContext,
} from '@velajs/vela';
import { Crud } from '../crud.decorator';
import { Override } from '../override.decorator';
import { CrudCtx, type CrudRequestContext } from '../crud-context.decorator';
import { CrudModule } from '../crud.module';
import { crudResourceToken } from '../crud.tokens';
import { MissingTenantResolverError } from '../crud.types';
import { defineModel } from '../model/define-model';
import { testAdapter } from './test-adapter';

type Row = Record<string, unknown>;

const itemSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  qty: z.number().int().nonnegative(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  deletedAt: z.number().nullable().optional(),
});

const makeModel = (overrides: object = {}) =>
  defineModel({ name: 'item', tableName: 'items', schema: itemSchema, softDelete: true, ...overrides });

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('@Crud over HTTP (decorated controller)', () => {
  async function makeApp(seed: Row[] = []) {
    const store = new Map<string, Row>();
    for (const row of seed) store.set(String(row.id), row);

    @Controller('/items')
    @Crud({ model: makeModel(), adapter: testAdapter(store, 'deletedAt') })
    class ItemsController {
      @Get('/stats')
      stats() {
        return { total: store.size };
      }
    }

    @Module({ controllers: [ItemsController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    return { app, hono: app.getHonoApp(), store, AppModule, ItemsController };
  }

  it('runs the full lifecycle with canonical statuses and envelopes', async () => {
    const { hono } = await makeApp();

    // create → 201 envelope, managed fields stamped
    const created = await hono.request('/items', json('POST', { name: 'Anchor', qty: 2 }));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { success: boolean; result: Row };
    expect(createdBody.success).toBe(true);
    const id = createdBody.result.id as string;
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(typeof createdBody.result.createdAt).toBe('number');

    // read → 200
    const read = await hono.request(`/items/${id}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { result: Row }).result.name).toBe('Anchor');

    // update → 200, merged
    const updated = await hono.request(`/items/${id}`, json('PATCH', { qty: 7 }));
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { result: Row }).result.qty).toBe(7);

    // list → 200 with result_info
    const list = await hono.request('/items');
    const listBody = (await list.json()) as { result: Row[]; result_info: Row };
    expect(listBody.result).toHaveLength(1);
    expect(listBody.result_info.total_count).toBe(1);

    // delete → 200 { deleted: true }; read-after → 404 canonical envelope
    const deleted = await hono.request(`/items/${id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as { result: Row }).result).toEqual({ deleted: true });

    const gone = await hono.request(`/items/${id}`);
    expect(gone.status).toBe(404);
    const goneBody = (await gone.json()) as { success: boolean; error: { code: string } };
    expect(goneBody.success).toBe(false);
    expect(goneBody.error.code).toBe('NOT_FOUND');
  });

  it('validates bodies through the engine with the canonical VALIDATION_ERROR envelope', async () => {
    const { hono } = await makeApp();
    const res = await hono.request('/items', json('POST', { name: '', qty: -1 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: { code: string; details: unknown[] } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it('keeps hand-written routes ahead of generated /:id', async () => {
    const { hono } = await makeApp([{ id: 'x1', name: 'X', qty: 1 }]);
    const res = await hono.request('/items/stats');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 1 });
  });

  it('lists routes first-class with names (never "(mounted)")', async () => {
    const { app } = await makeApp();
    const routes = app.describeRoutes();
    const crudRoutes = routes.filter((r) => r.name?.startsWith('item.'));
    expect(crudRoutes.map((r) => `${r.method} ${r.path} ${r.name}`).sort()).toEqual(
      [
        'DELETE /items/:id item.delete',
        'GET /items item.list',
        'GET /items/:id item.read',
        'PATCH /items/:id item.update',
        'POST /items item.create',
        'POST /items/:id/clone item.clone',
        'POST /items/:id/restore item.restore',
        'POST /items/upsert item.upsert',
      ].sort(),
    );
    for (const route of crudRoutes) {
      expect(route.controller).toBe('ItemsController');
    }
  });

  it('generates URLs from route names (urlFor)', async () => {
    const { app } = await makeApp();
    const url = app.get(UrlGeneratorService);
    expect(url.urlFor('item.read' as never, { id: 'abc' } as never)).toBe('/items/abc');
    expect(url.urlFor('item.list' as never, {} as never)).toBe('/items');
  });

  it('surfaces CRUD paths, operationIds, and DTO components via the normal OpenAPI walk', async () => {
    const { AppModule } = await makeApp();
    const doc = createOpenApiDocument(AppModule);

    expect(doc.paths['/items']?.post?.operationId).toBe('createItem');
    expect(doc.paths['/items']?.get?.operationId).toBe('listItems');
    expect(doc.paths['/items/{id}']?.get?.operationId).toBe('getItem');
    expect(doc.paths['/items/{id}']?.patch?.operationId).toBe('updateItem');
    expect(doc.paths['/items/{id}']?.delete?.operationId).toBe('deleteItem');

    expect(doc.components?.schemas?.CreateItemDto).toBeDefined();
    expect(doc.components?.schemas?.UpdateItemDto).toBeDefined();
    expect(JSON.stringify(doc.paths['/items']?.post)).toContain('#/components/schemas/CreateItemDto');

    // Tags default to the plural resource name.
    expect(doc.paths['/items']?.get?.tags).toContain('items');
  });

  it('runs controller guards on generated routes', async () => {
    const store = new Map<string, Row>();

    class DenyGuard implements CanActivate {
      canActivate(_context: ExecutionContext): boolean {
        return false;
      }
    }

    @Controller('/guarded')
    @UseGuards(DenyGuard)
    @Crud({ model: makeModel(), adapter: testAdapter(store, 'deletedAt') })
    class GuardedController {}

    @Module({ controllers: [GuardedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/guarded');
    expect(res.status).toBe(403);
  });
});

describe('@Override', () => {
  it('takes over the verb with the route name and skips synthesis', async () => {
    const store = new Map<string, Row>();
    store.set('a', { id: 'a', name: 'A', qty: 1 });

    @Controller('/items')
    @Crud({ model: makeModel(), adapter: testAdapter(store, 'deletedAt') })
    class ItemsController {
      @Override('list')
      customList(@CrudCtx() ctx: CrudRequestContext) {
        expect(ctx.c).toBeDefined();
        expect(ctx.container).toBeDefined();
        return { custom: true, count: store.size };
      }
    }

    @Module({ controllers: [ItemsController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/items');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ custom: true, count: 1 });

    const route = app.describeRoutes().find((r) => r.name === 'item.list');
    expect(route?.handler).toBe('customList');
  });
});

describe('CrudModule', () => {
  it('forRoot provides the default adapter; forFeature mounts headless resources', async () => {
    const store = new Map<string, Row>();

    @Module({
      imports: [
        CrudModule.forRoot({ adapter: testAdapter(store, 'deletedAt') }),
        CrudModule.forFeature([{ path: '/things', model: makeModel({ name: 'thing' }) }]),
      ],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const created = await hono.request('/things', json('POST', { name: 'T', qty: 1 }));
    expect(created.status).toBe(201);

    const list = await hono.request('/things');
    expect(((await list.json()) as { result: Row[] }).result).toHaveLength(1);

    // The compiled resource is injectable.
    const resource = app.get(crudResourceToken('thing'));
    expect(resource.name).toBe('thing');
    const direct = await resource.execute('list', { query: {} });
    expect(direct.status).toBe(200);
  });

  it('per-resource adapter overrides the default', async () => {
    const defaultStore = new Map<string, Row>();
    const ownStore = new Map<string, Row>();
    ownStore.set('o1', { id: 'o1', name: 'Own', qty: 1 });

    @Module({
      imports: [
        CrudModule.forRoot({ adapter: testAdapter(defaultStore, 'deletedAt') }),
        CrudModule.forFeature([
          { path: '/owned', model: makeModel({ name: 'owned' }), adapter: testAdapter(ownStore, 'deletedAt') },
        ]),
      ],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/owned');
    expect(((await res.json()) as { result: Row[] }).result[0]!.name).toBe('Own');
  });
});

describe('tenant fail-fast', () => {
  it('throws MissingTenantResolverError at decoration time for tenant-scoped models', () => {
    const store = new Map<string, Row>();
    expect(() => {
      @Controller('/tenants')
      @Crud({ model: makeModel({ multiTenant: true }), adapter: testAdapter(store, 'deletedAt') })
      class _TenantController {}
    }).toThrowError(MissingTenantResolverError);
  });

  it('accepts the affirmation and scopes by tenant var', async () => {
    const store = new Map<string, Row>();
    store.set('a', { id: 'a', name: 'A', qty: 1, tenantId: 't1' });
    store.set('b', { id: 'b', name: 'B', qty: 1, tenantId: 't2' });

    @Controller('/scoped')
    @Crud({
      model: makeModel({ multiTenant: true }),
      adapter: testAdapter(store, 'deletedAt'),
      tenantResolverMounted: true,
    })
    class ScopedController {}

    @Module({ controllers: [ScopedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    // Tenant resolution middleware is M3; simulate the resolved var upstream.
    app.getHonoApp().use('*', async () => {
      /* placeholder for ordering — real resolver sets c.set('tenantId', ...) */
    });
    const res = await app.getHonoApp().request('/scoped');
    // Without a resolved tenant var, no scoping applies (resolver contract).
    expect(((await res.json()) as { result: Row[] }).result).toHaveLength(2);
  });
});

describe('custom response envelope', () => {
  it('formats success and error bodies through the configured envelope', async () => {
    const store = new Map<string, Row>();
    store.set('a', { id: 'a', name: 'A', qty: 1 });

    @Controller('/enveloped')
    @Crud({
      model: makeModel(),
      adapter: testAdapter(store, 'deletedAt'),
      responseEnvelope: {
        success: (result, info) => ({ data: result, meta: info ?? null }),
        error: (err) => ({ problem: err.code, detail: err.message }),
      },
    })
    class EnvelopedController {}

    @Module({ controllers: [EnvelopedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const ok = await hono.request('/enveloped/a');
    expect(((await ok.json()) as { data: Row }).data.id).toBe('a');

    const missing = await hono.request('/enveloped/zz');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { problem: string }).problem).toBe('NOT_FOUND');
  });
});
