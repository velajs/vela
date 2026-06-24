import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  VelaFactory,
  Controller,
  Module,
  UseMiddleware,
  UseGuards,
  MetadataRegistry,
  ApiTags,
  createOpenApiDocument,
} from '@velajs/vela';
import type {
  CanActivate,
  ExecutionContext,
  NestMiddleware,
} from '@velajs/vela';
import type { Context, Next } from 'hono';
import { getCrudBridge } from '@velajs/vela/internal';
// Importing the package index is what registers the bridge (side-effect).
import { Crud, buildCrudOpenApiPaths } from '../index';
import type { CrudConfig } from '../index';

// Optional deps loaded the same way the existing CRUD suite does.
let defineMeta: Function;
let defineModel: Function;
let MemoryAdapters: unknown;
let clearStorage: Function;
let z: any;
let honoCrudAvailable = false;

beforeAll(async () => {
  try {
    const [honoCrudBase, zod, memMod, authMod, eventsMod] = await Promise.all([import('hono-crud'), import('zod'), import('@hono-crud/memory'), import('hono-crud/auth'), import('hono-crud/events')]);
    const honoCrud = { ...honoCrudBase, ...memMod, ...authMod, ...eventsMod };
    defineMeta = honoCrud.defineMeta;
    defineModel = honoCrud.defineModel;
    MemoryAdapters = honoCrud.MemoryAdapters;
    clearStorage = honoCrud.clearStorage;
    z = zod;
    honoCrudAvailable = true;
  } catch (e) {
    console.log('hono-crud not available, skipping bridge tests:', (e as Error).message);
  }
});

beforeEach(() => {
  MetadataRegistry.clear();
  if (clearStorage) clearStorage();
});

describe('vela bridge self-registration', () => {
  it('importing @velajs/crud registers a bridge on @velajs/vela/internal', () => {
    const bridge = getCrudBridge();
    expect(bridge).toBeDefined();
    expect(typeof bridge?.buildRoutes).toBe('function');
    expect(typeof bridge?.buildOpenApiPaths).toBe('function');
  });
});

describe('controller-level @UseMiddleware forwarding (regression: silent drop)', () => {
  it('runs controller @UseMiddleware on generated CRUD routes', async () => {
    if (!honoCrudAvailable) return;

    const Schema = z.object({ id: z.string(), name: z.string() });
    const Model = defineModel({ tableName: 'mw_things', schema: Schema, primaryKeys: ['id'] });
    const meta = defineMeta({ model: Model });

    class StampMiddleware implements NestMiddleware {
      async use(c: Context, next: Next): Promise<void> {
        c.header('x-mw-ran', 'yes');
        await next();
      }
    }

    @Controller('/things')
    @UseMiddleware(new StampMiddleware())
    @Crud({ meta, adapters: MemoryAdapters, only: ['list', 'create'] })
    class ThingController {}

    @Module({ controllers: [ThingController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // GET list — the regression guard: previously the middleware was dropped
    // and this header was absent.
    const listRes = await hono.request('/things');
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get('x-mw-ran')).toBe('yes');

    // POST create — middleware also runs on a mutating route.
    const createRes = await hono.request('/things', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a' }),
    });
    expect(createRes.status).toBe(201);
    expect(createRes.headers.get('x-mw-ran')).toBe('yes');
  });

  it('runs multiple controller @UseMiddleware in declaration order', async () => {
    if (!honoCrudAvailable) return;

    const Schema = z.object({ id: z.string(), name: z.string() });
    const Model = defineModel({ tableName: 'mw_multi', schema: Schema, primaryKeys: ['id'] });
    const meta = defineMeta({ model: Model });

    const seen: string[] = [];
    class FirstMw implements NestMiddleware {
      async use(_c: Context, next: Next): Promise<void> {
        seen.push('first');
        await next();
      }
    }
    class SecondMw implements NestMiddleware {
      async use(c: Context, next: Next): Promise<void> {
        seen.push('second');
        c.header('x-both', 'ran');
        await next();
      }
    }

    @Controller('/multi')
    @UseMiddleware(new FirstMw(), new SecondMw())
    @Crud({ meta, adapters: MemoryAdapters, only: ['list'] })
    class MultiController {}

    @Module({ controllers: [MultiController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/multi');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-both')).toBe('ran');
    expect(seen).toEqual(['first', 'second']);
  });
});

describe('ordering: controller middleware runs before guards', () => {
  it('a guard observes state the controller middleware set', async () => {
    if (!honoCrudAvailable) return;

    const Schema = z.object({ id: z.string(), name: z.string() });
    const Model = defineModel({ tableName: 'ord', schema: Schema, primaryKeys: ['id'] });
    const meta = defineMeta({ model: Model });

    const order: string[] = [];

    class SetsFlagMiddleware implements NestMiddleware {
      async use(c: Context, next: Next): Promise<void> {
        order.push('middleware');
        c.set('mwFlag', 'set-by-middleware');
        await next();
      }
    }

    class ReadsFlagGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        order.push('guard');
        const c = ctx.getContext<Context>();
        // If the middleware did NOT run first, this read is undefined and the
        // guard denies — the assertion below would then fail with a 403.
        return c.get('mwFlag') === 'set-by-middleware';
      }
    }

    @Controller('/ord')
    @UseMiddleware(new SetsFlagMiddleware())
    @UseGuards(new ReadsFlagGuard())
    @Crud({ meta, adapters: MemoryAdapters, only: ['list'] })
    class OrdController {}

    @Module({ controllers: [OrdController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/ord');

    expect(res.status).toBe(200);
    expect(order[0]).toBe('middleware');
    expect(order).toContain('guard');
    expect(order.indexOf('middleware')).toBeLessThan(order.indexOf('guard'));
  });
});

describe('buildCrudOpenApiPaths (delegates to hono-crud)', () => {
  function makeConfig(overrides: Partial<CrudConfig> = {}): CrudConfig {
    const Schema = z.object({
      id: z.string(),
      name: z.string(),
      email: z.string().email(),
    });
    const Model = defineModel({ tableName: 'users', schema: Schema, primaryKeys: ['id'] });
    const meta = defineMeta({ model: Model });
    return { meta, adapters: MemoryAdapters, ...overrides } as CrudConfig;
  }

  it('emits the FULL authoritative endpoint set (not just the old 5 verbs) with populated schemas', () => {
    if (!honoCrudAvailable) return;

    // No only/except → every CRUD verb hono-crud generates. The prior
    // hand-rolled emitter only ever produced 5 verbs on 2 paths; delegating
    // to hono-crud must surface search/batch/etc.
    const paths = buildCrudOpenApiPaths(
      class UsersController {} as never,
      makeConfig(),
      { globalPrefix: '/api', controllerPrefix: '/users' },
    );

    const keys = Object.keys(paths);
    // Core 2 paths still present.
    expect(keys).toContain('/api/users');
    expect(keys).toContain('/api/users/{id}');
    // Strictly richer than the legacy hand-rolled 2-path / 5-verb output:
    // search + batch endpoints prove the delegation.
    expect(keys).toContain('/api/users/search');
    expect(keys).toContain('/api/users/batch');
    expect(keys.length).toBeGreaterThan(2);

    const collection = paths['/api/users']!;
    const single = paths['/api/users/{id}']!;
    expect(collection.get).toBeDefined();
    expect(collection.post).toBeDefined();
    expect(single.get).toBeDefined();
    expect(single.patch).toBeDefined();
    expect(single.delete).toBeDefined();
    // search endpoint contributed by the authoritative source.
    expect(paths['/api/users/search']!.get).toBeDefined();

    // hono-crud's own list envelope schema (richer than the prior
    // hand-rolled `{ success: { type: 'boolean' } }` stub).
    const listSchema =
      collection.get!.responses['200']!.content!['application/json']!.schema;
    expect(listSchema.properties?.success).toBeDefined();
    expect(listSchema.properties?.result?.type).toBe('array');
    expect(listSchema.properties?.result_info?.type).toBe('object');
    // Model fields flow through into the list item schema.
    expect(
      Object.keys(listSchema.properties?.result?.items?.properties ?? {}),
    ).toEqual(expect.arrayContaining(['id', 'name', 'email']));

    // create request body is hono-crud's model-derived create schema.
    const createBody = collection.post!.requestBody!.content!['application/json']!.schema;
    expect(createBody.type).toBe('object');
    expect(Object.keys(createBody.properties ?? {})).toEqual(
      expect.arrayContaining(['name', 'email']),
    );

    // read item response carries the model schema.
    const readSchema = single.get!.responses['200']!.content!['application/json']!.schema;
    expect(readSchema.properties?.success).toBeDefined();
    expect(readSchema.properties?.result?.type).toBe('object');
  });

  it('respects only — filters which paths/verbs appear', () => {
    if (!honoCrudAvailable) return;
    const paths = buildCrudOpenApiPaths(
      class C {} as never,
      makeConfig({ only: ['list'] }),
      { globalPrefix: '', controllerPrefix: '/items' },
    );
    expect(Object.keys(paths)).toEqual(['/items']);
    expect(paths['/items']!.get).toBeDefined();
    expect(paths['/items']!.post).toBeUndefined();
    // search/batch are NOT emitted when not enabled.
    expect(paths['/items/search']).toBeUndefined();
    expect(paths['/items/batch']).toBeUndefined();
  });

  it('respects except — excluded verbs are absent', () => {
    if (!honoCrudAvailable) return;
    const paths = buildCrudOpenApiPaths(
      class C {} as never,
      makeConfig({
        except: [
          'create',
          'update',
          'delete',
          'read',
          'search',
          'aggregate',
          'restore',
          'batchCreate',
          'batchUpdate',
          'batchDelete',
          'batchRestore',
          'batchUpsert',
          'export',
          'import',
          'upsert',
          'clone',
          'bulkPatch',
        ],
      }),
      { globalPrefix: '/api', controllerPrefix: 'items' },
    );
    // Only list survives → collection GET, no `{id}` path, no search/batch.
    expect(Object.keys(paths)).toEqual(['/api/items']);
    expect(paths['/api/items']!.get).toBeDefined();
    expect(paths['/api/items']!.post).toBeUndefined();
    expect(paths['/api/items/{id}']).toBeUndefined();
    expect(paths['/api/items/search']).toBeUndefined();
  });

  it('forwards dto.create / dto.update through the shared endpoints-def helper', () => {
    if (!honoCrudAvailable) return;
    const CreateDto = z.object({ name: z.string() });
    const UpdateDto = z.object({ name: z.string().optional() });
    const paths = buildCrudOpenApiPaths(
      class C {} as never,
      makeConfig({ only: ['create', 'update'], dto: { create: CreateDto, update: UpdateDto } }),
      { globalPrefix: '/api', controllerPrefix: '/users' },
    );
    const createBody =
      paths['/api/users']!.post!.requestBody!.content!['application/json']!.schema;
    expect(Object.keys(createBody.properties ?? {})).toEqual(['name']);
  });

  it('joins globalPrefix + controllerPrefix and slash-normalizes the base path', () => {
    if (!honoCrudAvailable) return;
    const paths = buildCrudOpenApiPaths(
      class C {} as never,
      makeConfig({ only: ['list', 'read'] }),
      { globalPrefix: '/api/', controllerPrefix: '/users/' },
    );
    // Double slash collapsed, single leading slash, `:id` -> `{id}`.
    expect(Object.keys(paths).sort()).toEqual(['/api/users', '/api/users/{id}']);
  });

  it('@ApiTags on the controller overrides the emitted operation tag', () => {
    if (!honoCrudAvailable) return;

    @ApiTags('CustomUsers')
    @Controller('/users')
    class TaggedController {}

    const tagged = buildCrudOpenApiPaths(
      TaggedController as never,
      makeConfig({ only: ['list'] }),
      { globalPrefix: '', controllerPrefix: '/users' },
    );
    expect(tagged['/users']!.get!.tags).toEqual(['CustomUsers']);
  });

  it('without @ApiTags, falls back to hono-crud model.tag', () => {
    if (!honoCrudAvailable) return;
    const Schema = z.object({ id: z.string(), name: z.string() });
    const Model = defineModel({
      tableName: 'widgets',
      schema: Schema,
      primaryKeys: ['id'],
      tag: 'WidgetModelTag',
    });
    const meta = defineMeta({ model: Model });
    const paths = buildCrudOpenApiPaths(
      class PlainController {} as never,
      { meta, adapters: MemoryAdapters, only: ['list'] } as CrudConfig,
      { globalPrefix: '', controllerPrefix: '/widgets' },
    );
    expect(paths['/widgets']!.get!.tags).toEqual(['WidgetModelTag']);
  });

  it('without @ApiTags or model.tag, falls back to the table name', () => {
    if (!honoCrudAvailable) return;
    const paths = buildCrudOpenApiPaths(
      class PlainController {} as never,
      makeConfig({ only: ['list'] }),
      { globalPrefix: '', controllerPrefix: '/users' },
    );
    expect(paths['/users']!.get!.tags).toEqual(['users']);
  });
});

describe('bridge round-trip via createOpenApiDocument', () => {
  it('createOpenApiDocument includes the full bridge-contributed CRUD set', async () => {
    if (!honoCrudAvailable) return;

    const Schema = z.object({ id: z.string(), title: z.string() });
    const Model = defineModel({ tableName: 'posts', schema: Schema, primaryKeys: ['id'] });
    const meta = defineMeta({ model: Model });

    @ApiTags('Posts')
    @Controller('/posts')
    @Crud({ meta, adapters: MemoryAdapters })
    class PostController {}

    @Module({ controllers: [PostController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule, {
      info: { title: 'test', version: '0.0.0' },
      globalPrefix: '/api',
    });

    // Core CRUD paths.
    expect(doc.paths['/api/posts']).toBeDefined();
    expect(doc.paths['/api/posts']!.get).toBeDefined();
    expect(doc.paths['/api/posts']!.post).toBeDefined();
    expect(doc.paths['/api/posts/{id}']).toBeDefined();
    expect(doc.paths['/api/posts/{id}']!.get).toBeDefined();
    expect(doc.paths['/api/posts/{id}']!.patch).toBeDefined();
    expect(doc.paths['/api/posts/{id}']!.delete).toBeDefined();
    // Richer-than-legacy: the bridge now also contributes search/batch.
    expect(doc.paths['/api/posts/search']).toBeDefined();
    expect(doc.paths['/api/posts/batch']).toBeDefined();
    // @ApiTags still wins end-to-end.
    expect(doc.paths['/api/posts']!.get!.tags).toEqual(['Posts']);
  });
});
