import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { Crud, Override, buildCrudRoutes } from '../index';
import type { CrudConfig } from '../index';

let MemoryAdapters: any;
let defineMeta: any;
let defineModel: any;
let z: any;
let clearStorage: (() => void) | undefined;
let honoCrudAvailable = false;

beforeAll(async () => {
  try {
    const honoCrud = { ...(await import('hono-crud')), ...(await import('@hono-crud/memory')), ...(await import('hono-crud/auth')), ...(await import('hono-crud/events')) };
    const memory = await import('@hono-crud/memory');
    const zod = await import('zod');
    MemoryAdapters = honoCrud.MemoryAdapters;
    defineMeta = honoCrud.defineMeta;
    defineModel = honoCrud.defineModel;
    clearStorage = memory.clearStorage as () => void;
    z = zod.z;
    honoCrudAvailable = true;
  } catch {
    honoCrudAvailable = false;
  }
});

beforeEach(() => {
  if (honoCrudAvailable && clearStorage) clearStorage();
});

const ctx = () => ({ globalPrefix: '', globalGuards: [], joinPaths: (...p: string[]) => p.filter(Boolean).join('/') });

const newEndpoints = [
  'search', 'aggregate', 'restore',
  'batchCreate', 'batchUpdate', 'batchDelete', 'batchRestore', 'batchUpsert',
  'export', 'import', 'upsert', 'clone', 'bulkPatch',
] as const;

describe('endpoint widening (0.4.0)', () => {
  it('accepts every new endpoint name in only without throwing', async () => {
    if (!honoCrudAvailable) return;
    const meta = defineMeta({
      model: defineModel({
        tableName: 'widgets',
        schema: z.object({ id: z.string(), name: z.string() }),
        primaryKeys: ['id'],
      }),
    });
    for (const name of newEndpoints) {
      const config: CrudConfig = { meta, adapters: MemoryAdapters, only: [name] };
      const app = new Hono();
      class Stub {}
      await expect(buildCrudRoutes(app, Stub as any, '/widgets', config, ctx())).resolves.not.toThrow();
    }
  });

  it('accepts every new endpoint name in except without throwing', async () => {
    if (!honoCrudAvailable) return;
    const meta = defineMeta({
      model: defineModel({
        tableName: 'widgets',
        schema: z.object({ id: z.string(), name: z.string() }),
        primaryKeys: ['id'],
      }),
    });
    const app = new Hono();
    class Stub {}
    const config: CrudConfig = { meta, adapters: MemoryAdapters, except: [...newEndpoints] };
    await expect(buildCrudRoutes(app, Stub as any, '/widgets', config, ctx())).resolves.not.toThrow();
  });

  it('rejects truly unknown endpoint names with a clear message', async () => {
    if (!honoCrudAvailable) return;
    const meta = defineMeta({
      model: defineModel({
        tableName: 'widgets',
        schema: z.object({ id: z.string(), name: z.string() }),
        primaryKeys: ['id'],
      }),
    });
    const app = new Hono();
    class Stub {}
    const config: CrudConfig = { meta, adapters: MemoryAdapters, only: ['NOT_A_VERB' as any] };
    await expect(buildCrudRoutes(app, Stub as any, '/widgets', config, ctx())).rejects.toThrow(
      /unknown endpoint name 'NOT_A_VERB'/,
    );
  });

  it('registers a search route end-to-end', async () => {
    if (!honoCrudAvailable) return;
    const meta = defineMeta({
      model: defineModel({
        tableName: 'widgets',
        schema: z.object({ id: z.string(), name: z.string() }),
        primaryKeys: ['id'],
      }),
    });
    const app = new Hono();
    class Stub {}
    await buildCrudRoutes(app, Stub as any, '/widgets', { meta, adapters: MemoryAdapters, only: ['create', 'search'] }, ctx());
    await app.request('/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '1', name: 'wrench' }),
    });
    const res = await app.request('/widgets/search?q=wrench');
    expect(res.status).toBeLessThan(500);
  });

  it('registers a restore route end-to-end', async () => {
    if (!honoCrudAvailable) return;
    const meta = defineMeta({
      model: defineModel({
        tableName: 'widgets',
        schema: z.object({ id: z.string(), name: z.string() }),
        primaryKeys: ['id'],
        softDelete: true,
      }),
    });
    const app = new Hono();
    class Stub {}
    await buildCrudRoutes(app, Stub as any, '/widgets', { meta, adapters: MemoryAdapters, only: ['create', 'delete', 'restore'] }, ctx());
    await app.request('/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '1', name: 'wrench' }),
    });
    await app.request('/widgets/1', { method: 'DELETE' });
    const res = await app.request('/widgets/1/restore', { method: 'POST' });
    expect(res.status).toBeLessThan(500);
  });

  it('registers each batch route', async () => {
    if (!honoCrudAvailable) return;
    const meta = defineMeta({
      model: defineModel({
        tableName: 'widgets',
        schema: z.object({ id: z.string(), name: z.string() }),
        primaryKeys: ['id'],
        softDelete: true,
      }),
    });
    const app = new Hono();
    class Stub {}
    await buildCrudRoutes(app, Stub as any, '/widgets', {
      meta, adapters: MemoryAdapters,
      only: ['batchCreate', 'batchUpdate', 'batchDelete', 'batchRestore', 'batchUpsert'],
    }, ctx());
    const create = await app.request('/widgets/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }] }),
    });
    expect(create.status).toBeLessThan(500);
  });

  it('registers aggregate / upsert / clone / export / import', async () => {
    if (!honoCrudAvailable) return;
    const meta = defineMeta({
      model: defineModel({
        tableName: 'widgets',
        schema: z.object({ id: z.string(), name: z.string() }),
        primaryKeys: ['id'],
      }),
    });
    const app = new Hono();
    class Stub {}
    await buildCrudRoutes(app, Stub as any, '/widgets', {
      meta, adapters: MemoryAdapters,
      only: ['aggregate', 'upsert', 'clone', 'export', 'import'],
    }, ctx());
    const agg = await app.request('/widgets/aggregate?fn=count');
    expect(agg.status).toBeLessThan(500);
    const exp = await app.request('/widgets/export');
    expect(exp.status).toBeLessThan(500);
  });

  it('registers a bulkPatch route end-to-end', async () => {
    if (!honoCrudAvailable) return;
    const meta = defineMeta({
      model: defineModel({
        tableName: 'widgets',
        schema: z.object({ id: z.string(), name: z.string() }),
        primaryKeys: ['id'],
      }),
    });
    const app = new Hono();
    class Stub {}
    await buildCrudRoutes(app, Stub as any, '/widgets', { meta, adapters: MemoryAdapters, only: ['create', 'bulkPatch'] }, ctx());
    await app.request('/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '1', name: 'wrench' }),
    });
    await app.request('/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '2', name: 'hammer' }),
    });
    // bulkPatch body = the fields to SET on every matched row (a partial of the
    // model); filters go in the query string. No filter → matches all visible.
    const res = await app.request('/widgets/bulk', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'patched' }),
    });
    expect(res.status).toBeLessThan(500);
    const body = await res.json();
    const payload = body.result ?? body;
    expect(payload.matched).toBe(2);
    expect(payload.updated).toBe(2);
  });

  it('@Override targets a new endpoint name', async () => {
    if (!honoCrudAvailable) return;
    const meta = defineMeta({
      model: defineModel({
        tableName: 'widgets',
        schema: z.object({ id: z.string(), name: z.string() }),
        primaryKeys: ['id'],
      }),
    });

    @Crud({ meta, adapters: MemoryAdapters, only: ['search'] })
    class WidgetController {
      @Override('search')
      customSearch() {
        return new Response(JSON.stringify({ items: [], overridden: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    const app = new Hono();
    await buildCrudRoutes(app, WidgetController as any, '/widgets', { meta, adapters: MemoryAdapters, only: ['search'] }, ctx());
    const res = await app.request('/widgets/search?q=anything');
    const body = await res.json();
    expect(body.overridden).toBe(true);
  });
});
