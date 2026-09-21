import { VelaError } from '@velajs/errors';
import { describe, expect, it, vi } from 'vitest';

import { createWorkflows } from '../index';
import type { WorkflowBindingLike, WorkflowInstanceLike } from '../index';

const fakeInstance = (id: string): WorkflowInstanceLike => ({
  id,
  status: async () => ({ status: 'running' }),
  pause: async () => {},
  resume: async () => {},
  restart: async () => {},
  terminate: async () => {},
  sendEvent: async () => {},
});

const fakeBinding = (): WorkflowBindingLike & {
  create: ReturnType<typeof vi.fn>;
  createBatch: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} => ({
  create: vi.fn(async () => fakeInstance('created')),
  createBatch: vi.fn(async (batch: ReadonlyArray<unknown>) =>
    batch.map((_, i) => fakeInstance(`b${String(i)}`)),
  ),
  get: vi.fn(async (id: string) => fakeInstance(id)),
});

describe('createWorkflows', () => {
  it('resolves a handle that passes create/createBatch/get through to the binding', async () => {
    const binding = fakeBinding();
    const workflows = createWorkflows({ bindings: { orderPipeline: binding } });
    const handle = workflows.get('orderPipeline');

    const created = await handle.create({ params: { orderId: '1' } });
    expect(created.id).toBe('created');
    expect(binding.create).toHaveBeenCalledWith({ params: { orderId: '1' } });

    const batch = await handle.createBatch([{ params: {} }, { params: {} }]);
    expect(batch.map((i) => i.id)).toEqual(['b0', 'b1']);
    expect(binding.createBatch).toHaveBeenCalledOnce();

    const got = await handle.get('inst-9');
    expect(got.id).toBe('inst-9');
    expect(binding.get).toHaveBeenCalledWith('inst-9');
  });

  it('throws a VelaError listing declared workflows for an unknown name', () => {
    const workflows = createWorkflows({
      bindings: { orderPipeline: fakeBinding(), etl: fakeBinding() },
    });

    let thrown: unknown;
    try {
      // @ts-expect-error unknown binding names are rejected statically and at runtime
      workflows.get('missing');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VelaError);
    expect((thrown as VelaError).code).toBe('internal');
    expect((thrown as Error).message).toContain('unknown workflow "missing"');
    expect((thrown as Error).message).toContain('orderPipeline');
    expect((thrown as Error).message).toContain('etl');
  });

  it('reports when the registry is empty', () => {
    const workflows = createWorkflows({ bindings: {} });
    // @ts-expect-error the registry has no keys
    expect(() => workflows.get('anything')).toThrow(/the workflow registry is empty/);
  });
});
