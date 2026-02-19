import 'reflect-metadata';
import { describe, it, expect, beforeEach, beforeAll } from 'bun:test';
import {
  EdgestFactory,
  Controller,
  Get,
  Module,
  MetadataRegistry,
} from '../index.js';
import { CrudModule } from '../crud/index.js';
import type { CanActivate, ExecutionContext } from '../index.js';

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
    console.log('hono-crud not available:', (e as Error).message);
  }
});

beforeEach(() => {
  MetadataRegistry.clear();
  if (clearStorage) clearStorage();
});

describe('CrudModule.forResource()', () => {
  it('should create a standalone CRUD module with working routes', async () => {
    if (!honoCrudAvailable) return;

    const PostSchema = z.object({
      id: z.string(),
      title: z.string(),
      content: z.string(),
    });

    const PostModel = defineModel({
      tableName: 'posts',
      schema: PostSchema,
      primaryKeys: ['id'],
    });

    const postMeta = defineMeta({ model: PostModel });

    const postCrud = CrudModule.forResource('/posts', {
      meta: postMeta,
      adapters: MemoryAdapters,
      only: ['create', 'list', 'read', 'delete'],
    });

    @Module({
      imports: [postCrud as any],
    })
    class AppModule {}

    const app = await EdgestFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Create a post
    const createRes = await hono.request('/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hello', content: 'World' }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { result: { id: string; title: string } };
    expect(created.result.title).toBe('Hello');
    const postId = created.result.id;

    // List posts
    const listRes = await hono.request('/posts');
    expect(listRes.status).toBe(200);
    const listed = await listRes.json() as { result: unknown[] };
    expect(listed.result.length).toBe(1);

    // Read single post
    const readRes = await hono.request(`/posts/${postId}`);
    expect(readRes.status).toBe(200);
    const read = await readRes.json() as { result: { title: string } };
    expect(read.result.title).toBe('Hello');

    // Delete post
    const deleteRes = await hono.request(`/posts/${postId}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(200);

    // Verify deleted
    const listRes2 = await hono.request('/posts');
    const listed2 = await listRes2.json() as { result: unknown[] };
    expect(listed2.result.length).toBe(0);
  });

  it('should apply guards via ResourceConfig', async () => {
    if (!honoCrudAvailable) return;

    const NoteSchema = z.object({
      id: z.string(),
      text: z.string(),
    });

    const NoteModel = defineModel({
      tableName: 'notes',
      schema: NoteSchema,
      primaryKeys: ['id'],
    });

    const noteMeta = defineMeta({ model: NoteModel });

    class ApiKeyGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.getRequest();
        return req.headers.get('x-api-key') === 'valid-key';
      }
    }

    const noteCrud = CrudModule.forResource('/notes', {
      meta: noteMeta,
      adapters: MemoryAdapters,
      only: ['create', 'list'],
      guards: [new ApiKeyGuard()],
    });

    @Module({
      imports: [noteCrud as any],
    })
    class AppModule {}

    const app = await EdgestFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Without API key — 403
    const res1 = await hono.request('/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Secret note' }),
    });
    expect(res1.status).toBe(403);

    // With API key — 201
    const res2 = await hono.request('/notes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'valid-key',
      },
      body: JSON.stringify({ text: 'Secret note' }),
    });
    expect(res2.status).toBe(201);

    // List with API key
    const res3 = await hono.request('/notes', {
      headers: { 'x-api-key': 'valid-key' },
    });
    expect(res3.status).toBe(200);
    const data = await res3.json() as { result: unknown[] };
    expect(data.result.length).toBe(1);
  });

  it('should coexist with regular controllers in the same app', async () => {
    if (!honoCrudAvailable) return;

    const TagSchema = z.object({
      id: z.string(),
      name: z.string(),
    });

    const TagModel = defineModel({
      tableName: 'tags',
      schema: TagSchema,
      primaryKeys: ['id'],
    });

    const tagMeta = defineMeta({ model: TagModel });

    const tagCrud = CrudModule.forResource('/tags', {
      meta: tagMeta,
      adapters: MemoryAdapters,
      only: ['create', 'list'],
    });

    @Controller('/health')
    class HealthController {
      @Get()
      check() {
        return { status: 'ok' };
      }
    }

    @Module({
      imports: [tagCrud as any],
      controllers: [HealthController],
    })
    class AppModule {}

    const app = await EdgestFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Health endpoint works
    const healthRes = await hono.request('/health');
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: 'ok' });

    // CRUD create works
    const createRes = await hono.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'typescript' }),
    });
    expect(createRes.status).toBe(201);

    // CRUD list works
    const listRes = await hono.request('/tags');
    expect(listRes.status).toBe(200);
    const listed = await listRes.json() as { result: unknown[] };
    expect(listed.result.length).toBe(1);
  });

  it('should respect except to exclude specific operations', async () => {
    if (!honoCrudAvailable) return;

    const ItemSchema = z.object({
      id: z.string(),
      label: z.string(),
    });

    const ItemModel = defineModel({
      tableName: 'labels',
      schema: ItemSchema,
      primaryKeys: ['id'],
    });

    const itemMeta = defineMeta({ model: ItemModel });

    const itemCrud = CrudModule.forResource('/labels', {
      meta: itemMeta,
      adapters: MemoryAdapters,
      except: ['delete', 'update'],
    });

    @Module({ imports: [itemCrud as any] })
    class AppModule {}

    const app = await EdgestFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Create works
    const createRes = await hono.request('/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'important' }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { result: { id: string } };

    // List works
    const listRes = await hono.request('/labels');
    expect(listRes.status).toBe(200);

    // Read works
    const readRes = await hono.request(`/labels/${created.result.id}`);
    expect(readRes.status).toBe(200);

    // Delete should 404 (not registered)
    const deleteRes = await hono.request(`/labels/${created.result.id}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(404);
  });
});
