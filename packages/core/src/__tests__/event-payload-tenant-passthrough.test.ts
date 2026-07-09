import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { buildCrudRoutes } from '../index';
import type { CrudConfig } from '../index';

let MemoryAdapters: unknown;
let defineMeta: ((opts: { model: unknown }) => unknown) | undefined;
let defineModel: ((opts: unknown) => unknown) | undefined;
let CrudEventEmitter: (new () => {
  on: (
    table: string,
    type: 'created' | 'updated' | 'deleted' | 'restored',
    listener: (event: unknown) => void,
  ) => unknown;
  removeAll: () => void;
}) | undefined;
let setEventEmitter: ((emitter: unknown) => void) | undefined;
let z: typeof import('zod') | undefined;
let clearStorage: (() => void) | undefined;
let honoCrudAvailable = false;

beforeAll(async () => {
  try {
    const honoCrud = { ...(await import('hono-crud')), ...(await import('@hono-crud/memory')), ...(await import('hono-crud/auth')), ...(await import('hono-crud/events')) };
    const memory = await import('@hono-crud/memory');
    const zod = await import('zod');
    MemoryAdapters = honoCrud.MemoryAdapters;
    defineMeta = honoCrud.defineMeta as typeof defineMeta;
    defineModel = honoCrud.defineModel as typeof defineModel;
    clearStorage = memory.clearStorage as () => void;
    CrudEventEmitter = honoCrud.CrudEventEmitter as typeof CrudEventEmitter;
    setEventEmitter = honoCrud.setEventEmitter as typeof setEventEmitter;
    z = zod;
    honoCrudAvailable = true;
  } catch {
    honoCrudAvailable = false;
  }
});

beforeEach(() => {
  if (honoCrudAvailable && clearStorage) clearStorage();
});

const ctx = () => ({
  globalPrefix: '',
  globalGuards: [],
  joinPaths: (...p: string[]) => p.filter(Boolean).join(''),
});

describe('CrudEventPayload tenantId/organizationId pass-through (0.6.0)', () => {
  it('emits created with tenantId + organizationId from c.var', async () => {
    if (!honoCrudAvailable) return;
    const emitter = new CrudEventEmitter!();
    setEventEmitter!(emitter);

    const observed: Array<{
      type: string;
      table: string;
      tenantId?: string;
      organizationId?: string;
      userId?: string;
    }> = [];
    // CrudEventEmitter.on(table, type, listener) — three args, not a
    // dot-joined string. The plan's `emitter.on('widgets.created', fn)`
    // form was a pre-0.7.0 sketch.
    emitter.on('widgets', 'created', (payload) =>
      observed.push(payload as (typeof observed)[number]),
    );

    const schema = z!.object({ id: z!.string(), name: z!.string() });
    const model = defineModel!({ tableName: 'widgets', schema, primaryKeys: ['id'] });
    const meta = defineMeta!({ model });

    const config: CrudConfig = {
      meta: meta as never,
      adapters: MemoryAdapters as never,
      only: ['create'],
    };
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-A');
      c.set('organizationId', 'org-1');
      c.set('userId', 'alice');
      await next();
    });
    class Stub {}
    await buildCrudRoutes(app, Stub as never, '/widgets', config, ctx());
    const res = await app.request('/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a' }),
    });
    expect(res.status).toBe(201);

    expect(observed.length).toBeGreaterThan(0);
    const event = observed[0];
    expect(event.table).toBe('widgets');
    expect(event.type).toBe('created');
    // The CrudEventPayload reads c.var.organizationId and the resolved
    // tenant id directly. Without a multi-tenant config, hono-crud's
    // getTenantId() returns undefined — but organizationId is read as a
    // raw context var and DOES surface here.
    expect(event.organizationId).toBe('org-1');
    expect(event.userId).toBe('alice');
  });
});
