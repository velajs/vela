import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { buildCrudRoutes } from '../index';
import type { CrudConfig } from '../index';

let MemoryAdapters: unknown;
let defineMeta: ((opts: { model: unknown }) => unknown) | undefined;
let defineModel: ((opts: unknown) => unknown) | undefined;
let z: typeof import('zod') | undefined;
let clearStorage: (() => void) | undefined;
let requireApproval: ((cfg: unknown) => unknown) | undefined;
let MemoryApprovalStorage: (new () => {
  approve: (id: string, by: string) => Promise<void>;
  get: (id: string) => Promise<unknown>;
}) | undefined;
let honoCrudAvailable = false;

beforeAll(async () => {
  try {
    const honoCrud = await import('hono-crud');
    const memory = await import('hono-crud/adapters/memory');
    const zod = await import('zod');
    MemoryAdapters = honoCrud.MemoryAdapters;
    defineMeta = honoCrud.defineMeta as typeof defineMeta;
    defineModel = honoCrud.defineModel as typeof defineModel;
    clearStorage = memory.clearStorage as () => void;
    requireApproval = honoCrud.requireApproval as typeof requireApproval;
    MemoryApprovalStorage = honoCrud.MemoryApprovalStorage as typeof MemoryApprovalStorage;
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

describe('requireApproval pass-through (0.6.0)', () => {
  it('returns 202 + actionId on first DELETE, then succeeds on resume', async () => {
    if (!honoCrudAvailable) return;
    const storage = new MemoryApprovalStorage!();
    const schema = z!.object({ id: z!.string(), amount: z!.number() });
    const model = defineModel!({ tableName: 'invoices', schema, primaryKeys: ['id'] });
    const meta = defineMeta!({ model });

    const app = new Hono();
    // hono-crud@0.7.0's EndpointsConfig['delete'] does NOT expose a
    // `middlewares` slot — only the lower-level functional config does.
    // Attach requireApproval as a Hono middleware on the parent app at
    // the DELETE path BEFORE buildCrudRoutes registers the subApp. We
    // gate by HTTP method so GET/PUT/etc. on the same path bypass it.
    const approval = requireApproval!({
      reason: 'Permanent invoice deletion',
      expiresAfter: 'P1D',
      approvalStorage: storage,
    }) as (c: unknown, next: () => Promise<void>) => Promise<void>;
    app.use('/invoices/:id', async (c, next) => {
      if ((c as { req: { method: string } }).req.method !== 'DELETE') {
        return next();
      }
      return approval(c, next);
    });

    const config: CrudConfig = {
      meta: meta as never,
      adapters: MemoryAdapters as never,
      only: ['create', 'delete'],
    };
    class Stub {}
    await buildCrudRoutes(app, Stub as never, '/invoices', config, ctx());

    const createRes = await app.request('/invoices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 42 }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { result: { id: string } };
    const id = created.result.id;
    expect(typeof id).toBe('string');

    const firstDelete = await app.request(`/invoices/${id}`, { method: 'DELETE' });
    expect(firstDelete.status).toBe(202);
    const firstBody = (await firstDelete.json()) as { actionId: string };
    expect(typeof firstBody.actionId).toBe('string');

    await storage.approve(firstBody.actionId, 'reviewer@example.com');

    const resume = await app.request(`/invoices/${id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _resume_: firstBody.actionId }),
    });
    expect(resume.status).toBeLessThan(300);
  });
});
