import { describe, it, expect, beforeAll } from 'vitest';
import { CrudService } from '../index';

let MemoryAdapters: unknown;
let metaFn: ((opts: { model: unknown }) => unknown) | undefined;
let modelFn: ((opts: unknown) => unknown) | undefined;
let z: typeof import('zod') | undefined;
let honoCrudAvailable = false;

beforeAll(async () => {
  try {
    const [honoCrudBase, zod, memMod, authMod, eventsMod] = await Promise.all([import('hono-crud'), import('zod'), import('@hono-crud/memory'), import('hono-crud/auth'), import('hono-crud/events')]);
    const honoCrud = { ...honoCrudBase, ...memMod, ...authMod, ...eventsMod };
    metaFn = honoCrud.defineMeta as typeof metaFn;
    modelFn = honoCrud.defineModel as typeof modelFn;
    MemoryAdapters = honoCrud.MemoryAdapters;
    z = zod;
    honoCrudAvailable = true;
  } catch {
    honoCrudAvailable = false;
  }
});

describe('CrudService<T>', () => {
  it('can be subclassed and exposes meta + adapters', () => {
    if (!honoCrudAvailable) return;

    interface User {
      id: string;
      name: string;
    }

    const schema = z!.object({ id: z!.string(), name: z!.string() });
    const model = modelFn!({ tableName: 'users', schema, primaryKeys: ['id'] });
    const meta = metaFn!({ model });

    class UserService extends CrudService<User> {
      readonly meta = meta as never;
      readonly adapters = MemoryAdapters as never;
    }

    const svc = new UserService();
    expect(svc.meta).toBe(meta);
    expect(svc.adapters).toBe(MemoryAdapters);
  });
});
