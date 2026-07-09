import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Module, VelaFactory, MetadataRegistry } from '@velajs/vela';
import { CrudModule, defineCrudResource } from '../index';

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
  MetadataRegistry.clear();
  if (honoCrudAvailable && clearStorage) clearStorage();
});

const buildMeta = () => {
  const baseSchema = z.object({ id: z.string(), name: z.string() });
  return defineMeta({
    model: defineModel({
      tableName: 'users',
      schema: baseSchema,
      primaryKeys: ['id'],
      resolveSchema: (ctx: any) => {
        const tenantId =
          ctx?.tenantId ??
          (typeof ctx?.request?.headers?.get === 'function'
            ? ctx.request.headers.get('x-tenant')
            : undefined);
        if (tenantId === 'tenant-with-priority') {
          return baseSchema.extend({ priority: z.enum(['low', 'high']) });
        }
        return baseSchema;
      },
    }),
  });
};

describe('Model.resolveSchema pass-through (0.5.0)', () => {
  it('rejects POST without priority for the priority tenant', async () => {
    if (!honoCrudAvailable) return;
    @Module({
      imports: [
        CrudModule.forResource('/users', { meta: buildMeta(), adapters: MemoryAdapters }),
      ],
    })
    class App {}
    const app = await VelaFactory.create(App);
    const res = await app.getHonoApp().request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant': 'tenant-with-priority' },
      body: JSON.stringify({ id: 'u1', name: 'A' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts POST without priority for other tenants', async () => {
    if (!honoCrudAvailable) return;
    @Module({
      imports: [
        CrudModule.forResource('/users', { meta: buildMeta(), adapters: MemoryAdapters }),
      ],
    })
    class App {}
    const app = await VelaFactory.create(App);
    const res = await app.getHonoApp().request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant': 'tenant-default' },
      body: JSON.stringify({ id: 'u1', name: 'A' }),
    });
    expect(res.status).toBe(201);
  });

  it('forwards resolveSchema through defineCrudResource', async () => {
    if (!honoCrudAvailable) return;
    @Module({
      imports: [defineCrudResource({ path: '/users', meta: buildMeta(), adapters: MemoryAdapters })],
    })
    class App {}
    const app = await VelaFactory.create(App);
    const res = await app.getHonoApp().request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant': 'tenant-with-priority' },
      body: JSON.stringify({ id: 'u1', name: 'A', priority: 'high' }),
    });
    expect(res.status).toBe(201);
  });
});
