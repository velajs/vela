import 'reflect-metadata';
import { describe, it, expect, beforeEach, beforeAll } from 'bun:test';
import {
  VelaFactory,
  Controller,
  Get,
  Module,
  UseGuards,
  MetadataRegistry,
} from '@velajs/vela';
import { Crud } from '../index';
import type { CanActivate, ExecutionContext } from '@velajs/vela';

// Dynamic imports for optional deps
let defineMeta: Function;
let defineModel: Function;
let MemoryAdapters: unknown;
let clearStorage: Function;
let z: any;
let honoCrudAvailable = false;

beforeAll(async () => {
  try {
    const [honoCrud, zod] = await Promise.all([
      import('hono-crud'),
      import('zod'),
    ]);
    defineMeta = honoCrud.defineMeta;
    defineModel = honoCrud.defineModel;
    MemoryAdapters = honoCrud.MemoryAdapters;
    clearStorage = honoCrud.clearStorage;
    z = zod;
    honoCrudAvailable = true;
  } catch (e) {
    console.log('hono-crud not available, skipping CRUD tests:', (e as Error).message);
  }
});

// Clean state before each test
beforeEach(() => {
  MetadataRegistry.clear();
  if (clearStorage) clearStorage();
});

describe('CRUD integration', () => {
  it('should generate CRUD routes via @Crud() decorator', async () => {
    if (!honoCrudAvailable) return;

    const UserSchema = z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
    });

    const UserModel = defineModel({
      tableName: 'users',
      schema: UserSchema,
      primaryKeys: ['id'],
    });

    const userMeta = defineMeta({ model: UserModel });

    @Controller('/users')
    @Crud({
      meta: userMeta,
      adapters: MemoryAdapters,
      only: ['create', 'list', 'read'],
    })
    class UserController {
      @Get('/me')
      getMe() {
        return { id: 'current-user', name: 'Me' };
      }
    }

    @Module({ controllers: [UserController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Test custom route still works
    const meRes = await hono.request('/users/me');
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toEqual({ id: 'current-user', name: 'Me' });

    // Test CRUD create (hono-crud returns 201 for creates)
    const createRes = await hono.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { result: { id: string; name: string } };
    expect(created.result.name).toBe('Alice');
    const userId = created.result.id;

    // Test CRUD list
    const listRes = await hono.request('/users');
    expect(listRes.status).toBe(200);
    const listed = await listRes.json() as { result: unknown[] };
    expect(listed.result.length).toBe(1);

    // Test CRUD read
    const readRes = await hono.request(`/users/${userId}`);
    expect(readRes.status).toBe(200);
    const read = await readRes.json() as { result: { name: string } };
    expect(read.result.name).toBe('Alice');
  });

  it('should apply controller guards to CRUD routes', async () => {
    if (!honoCrudAvailable) return;

    const ItemSchema = z.object({
      id: z.string(),
      title: z.string(),
    });

    const ItemModel = defineModel({
      tableName: 'items',
      schema: ItemSchema,
      primaryKeys: ['id'],
    });

    const itemMeta = defineMeta({ model: ItemModel });

    class AuthGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.getRequest();
        return req.headers.get('authorization') === 'Bearer valid';
      }
    }

    @Controller('/items')
    @UseGuards(new AuthGuard())
    @Crud({
      meta: itemMeta,
      adapters: MemoryAdapters,
      only: ['create', 'list'],
    })
    class ItemController {}

    @Module({ controllers: [ItemController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Without auth — 403
    const res1 = await hono.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test' }),
    });
    expect(res1.status).toBe(403);

    // With auth — 201 (hono-crud returns 201 for creates)
    const res2 = await hono.request('/items', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': 'Bearer valid',
      },
      body: JSON.stringify({ title: 'Test' }),
    });
    expect(res2.status).toBe(201);
  });
});
