import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  VelaFactory,
  Module,
  MetadataRegistry,
} from '@velajs/vela';
import type { CanActivate, ExecutionContext } from '@velajs/vela';
import { CrudModule, defineCrudResource } from '../index';

let defineMeta: any;
let defineModel: any;
let MemoryAdapters: any;
let clearStorage: (() => void) | undefined;
let z: any;
let honoCrudAvailable = false;

beforeAll(async () => {
  try {
    const honoCrud = { ...(await import('hono-crud')), ...(await import('@hono-crud/memory')), ...(await import('hono-crud/auth')), ...(await import('hono-crud/events')) };
    const memory = await import('@hono-crud/memory');
    const zod = await import('zod');
    defineMeta = honoCrud.defineMeta;
    defineModel = honoCrud.defineModel;
    MemoryAdapters = honoCrud.MemoryAdapters;
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

function userMeta() {
  const UserSchema = z.object({
    id: z.string(),
    name: z.string(),
  });
  const UserModel = defineModel({
    tableName: 'users',
    schema: UserSchema,
    primaryKeys: ['id'],
  });
  return defineMeta({ model: UserModel });
}

describe('defineCrudResource()', () => {
  it('produces a DynamicModule that registers identically to CrudModule.forResource', async () => {
    if (!honoCrudAvailable) return;

    // App via defineCrudResource
    const helperResource = defineCrudResource({
      path: '/users',
      meta: userMeta(),
      adapters: MemoryAdapters,
      only: ['create', 'list'],
    });

    @Module({ imports: [helperResource as any] })
    class HelperApp {}

    const helperApp = await VelaFactory.create(HelperApp);
    const helperHono = helperApp.getHonoApp();

    const helperRes = await helperHono.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alice' }),
    });
    expect(helperRes.status).toBe(201);

    // Reset and build via CrudModule.forResource for the parity check
    MetadataRegistry.clear();
    if (clearStorage) clearStorage();

    const moduleResource = CrudModule.forResource('/users', {
      meta: userMeta(),
      adapters: MemoryAdapters,
      only: ['create', 'list'],
    });

    @Module({ imports: [moduleResource as any] })
    class ModuleApp {}

    const moduleApp = await VelaFactory.create(ModuleApp);
    const moduleHono = moduleApp.getHonoApp();

    const moduleRes = await moduleHono.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bob' }),
    });
    expect(moduleRes.status).toBe(201);

    // Both DynamicModules should expose a single controller
    expect(Array.isArray(helperResource.controllers)).toBe(true);
    expect(helperResource.controllers!.length).toBe(1);
    expect(Array.isArray(moduleResource.controllers)).toBe(true);
    expect(moduleResource.controllers!.length).toBe(1);
  });

  it('overrides registered through helper behave like @Override-decorated methods', async () => {
    if (!honoCrudAvailable) return;

    const resource = defineCrudResource({
      path: '/users',
      meta: userMeta(),
      adapters: MemoryAdapters,
      only: ['list'],
      overrides: {
        list: (c) => c.json({ items: [], overridden: true }),
      },
    });

    @Module({ imports: [resource as any] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { overridden?: boolean };
    expect(body.overridden).toBe(true);
  });

  it('forwards guards through the resource', async () => {
    if (!honoCrudAvailable) return;

    class DenyGuard implements CanActivate {
      canActivate(_context: ExecutionContext): boolean {
        return false;
      }
    }

    const resource = defineCrudResource({
      path: '/users',
      meta: userMeta(),
      adapters: MemoryAdapters,
      only: ['list'],
      guards: [new DenyGuard()],
    });

    @Module({ imports: [resource as any] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/users');
    expect(res.status).toBe(403);
  });
});
