import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { buildCrudRoutes } from '../index';
import type { CrudConfig } from '../index';

let MemoryAdapters: unknown;
let defineMeta: ((opts: { model: unknown }) => unknown) | undefined;
let defineModel: ((opts: unknown) => unknown) | undefined;
let requireApproval: ((cfg: unknown) => unknown) | undefined;
let MemoryApprovalStorage: (new () => {
  get: (id: string) => Promise<{
    id: string;
    userId?: string;
    actorUserId?: string;
    agentId?: string;
    agentRunId?: string;
  } | null>;
}) | undefined;
let z: typeof import('zod') | undefined;
let clearStorage: (() => void) | undefined;
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

describe('actor-aware approval pass-through (0.6.0)', () => {
  it('persists actorUserId + agentId + agentRunId on PendingAction', async () => {
    if (!honoCrudAvailable) return;
    const storage = new MemoryApprovalStorage!();
    const schema = z!.object({ id: z!.string(), amount: z!.number() });
    const model = defineModel!({ tableName: 'invoices', schema, primaryKeys: ['id'] });
    const meta = defineMeta!({ model });

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('userId', 'alice');
      c.set('agentId', 'agent-007');
      c.set('agentRunId', 'run-42');
      await next();
    });
    // hono-crud@0.7.0's EndpointsConfig['delete'] does NOT expose a
    // `middlewares` slot. Attach requireApproval as a Hono middleware on
    // the parent app, gated by HTTP method so the create POST isn't
    // intercepted.
    const approval = requireApproval!({
      reason: 'agent-driven delete',
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

    const res = await app.request(`/invoices/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { actionId: string };
    const action = await storage.get(body.actionId);
    expect(action).not.toBeNull();
    // hono-crud's PendingAction stores both `userId` (caller-on-behalf
    // surface) and `actorUserId` (actor identity). The minified store
    // populates both from c.var.userId, so we accept either field.
    expect(action!.actorUserId ?? action!.userId).toBe('alice');
    expect(action!.agentId).toBe('agent-007');
    expect(action!.agentRunId).toBe('run-42');
  });
});
