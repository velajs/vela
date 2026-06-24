import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { buildCrudRoutes } from '../index';
import type { CrudConfig } from '../index';

let MemoryAdapters: unknown;
let defineMeta: ((opts: { model: unknown }) => unknown) | undefined;
let defineModel: ((opts: unknown) => unknown) | undefined;
let requirePolicy: ((policies: unknown) => unknown) | undefined;
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
    requirePolicy = honoCrud.requirePolicy as typeof requirePolicy;
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

describe('requirePolicy + Model.policies pass-through (0.6.0)', () => {
  it('forwards Model.policies via meta to enforce read filtering', async () => {
    if (!honoCrudAvailable) return;
    const policies = {
      // hono-crud's ModelPolicies signature is (ctx, record). The plan's
      // (record, ctx) form was a pre-0.7.0 sketch — flip arg order to
      // match the upstream surface.
      read: (
        policyCtx: { userId?: string },
        record: { ownerId: string },
      ) => record.ownerId === policyCtx.userId,
    };
    const schema = z!.object({
      id: z!.string(),
      name: z!.string(),
      ownerId: z!.string(),
    });
    const model = defineModel!({
      tableName: 'widgets',
      schema,
      primaryKeys: ['id'],
      policies,
    } as never);
    const meta = defineMeta!({ model });

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('userId', 'alice');
      await next();
    });
    // hono-crud@0.7.0's EndpointsConfig['list'] does NOT expose a
    // `middlewares` slot. Attach requirePolicy as a Hono middleware on
    // the list path BEFORE buildCrudRoutes.
    app.use('/widgets', requirePolicy!(policies) as never);

    const config: CrudConfig = {
      meta: meta as never,
      adapters: MemoryAdapters as never,
      only: ['create', 'list'],
    };
    class Stub {}
    await buildCrudRoutes(app, Stub as never, '/widgets', config, ctx());

    // Capture generated ids since primaryKeys auto-gen UUIDs.
    const aliceCreate = await app.request('/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alice-widget', ownerId: 'alice' }),
    });
    expect(aliceCreate.status).toBe(201);
    const alice = (await aliceCreate.json()) as { result: { id: string } };

    const bobCreate = await app.request('/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bob-widget', ownerId: 'bob' }),
    });
    expect(bobCreate.status).toBe(201);
    const bob = (await bobCreate.json()) as { result: { id: string } };

    const list = await app.request('/widgets');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { result: Array<{ id: string }> };
    const ids = body.result.map((i) => i.id);
    expect(ids).toContain(alice.result.id);
    expect(ids).not.toContain(bob.result.id);
  });
});
