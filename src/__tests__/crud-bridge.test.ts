import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Controller,
  Get,
  Module,
  MetadataRegistry,
  METADATA_KEYS,
  VelaFactory,
  createOpenApiDocument,
  defineMetadata,
} from '../index.js';
import {
  registerCrudBridge,
  getCrudBridge,
  type CrudBridge,
} from '../internal.js';
import { _resetCrudBridge } from '../http/crud-bridge.js';

beforeEach(() => {
  MetadataRegistry.clear();
  _resetCrudBridge();
});

describe('CrudBridge registry', () => {
  it('returns undefined when no bridge has been registered', () => {
    expect(getCrudBridge()).toBeUndefined();
  });

  it('registers and retrieves a bridge instance', () => {
    const bridge: CrudBridge = {
      buildRoutes: async () => {},
      buildOpenApiPaths: () => ({}),
    };

    registerCrudBridge(bridge);

    expect(getCrudBridge()).toBe(bridge);
  });

  it('last-writer-wins on repeated registration', () => {
    const first: CrudBridge = {
      buildRoutes: async () => {},
      buildOpenApiPaths: () => ({}),
    };
    const second: CrudBridge = {
      buildRoutes: async () => {},
      buildOpenApiPaths: () => ({}),
    };

    registerCrudBridge(first);
    registerCrudBridge(second);

    expect(getCrudBridge()).toBe(second);
    expect(getCrudBridge()).not.toBe(first);
  });

  it('_resetCrudBridge clears the registration', () => {
    registerCrudBridge({
      buildRoutes: async () => {},
      buildOpenApiPaths: () => ({}),
    });
    expect(getCrudBridge()).toBeDefined();

    _resetCrudBridge();

    expect(getCrudBridge()).toBeUndefined();
  });
});

describe('RouteManager — CRUD bridge integration', () => {
  it('throws the install-it error when a controller has vela:crud metadata and no bridge is registered', async () => {
    @Controller('/users')
    class UsersController {
      @Get('/ping') ping() { return { ok: true }; }
    }
    defineMetadata(METADATA_KEYS.CRUD, { entity: 'User' }, UsersController);

    @Module({ controllers: [UsersController] })
    class AppModule {}

    await expect(VelaFactory.create(AppModule)).rejects.toThrow(
      /@Crud\(\) requires '@velajs\/crud'\. Install it: pnpm add @velajs\/crud/,
    );
  });

  it('calls bridge.buildRoutes with (app, controller, prefix, crudConfig, ctx) when a bridge is registered', async () => {
    @Controller('/items')
    class ItemsController {}
    const crudConfig = { entity: 'Item', pagination: { defaultLimit: 25 } };
    defineMetadata(METADATA_KEYS.CRUD, crudConfig, ItemsController);

    @Module({ controllers: [ItemsController] })
    class AppModule {}

    const buildRoutes = vi.fn(async () => {});
    const buildOpenApiPaths = vi.fn(() => ({}));

    registerCrudBridge({ buildRoutes, buildOpenApiPaths });

    const app = await VelaFactory.create(AppModule, { globalPrefix: '/api' });

    expect(buildRoutes).toHaveBeenCalledTimes(1);
    const [appArg, controllerArg, prefixArg, configArg, ctxArg] = buildRoutes.mock.calls[0]!;
    // First arg should be the Hono app (has .fetch / .request)
    expect(appArg).toBe(app.getHonoApp());
    expect(controllerArg).toBe(ItemsController);
    expect(prefixArg).toBe('/items');
    expect(configArg).toBe(crudConfig);
    expect(ctxArg).toMatchObject({
      globalPrefix: '/api',
      globalGuards: expect.any(Array),
      joinPaths: expect.any(Function),
    });
    // Sanity-check the path joiner is the real one (normalizes leading slashes,
    // joins without double slashes).
    expect((ctxArg as { joinPaths: (...p: string[]) => string }).joinPaths('/api', 'users')).toBe('/api/users');
  });

  it('surfaces errors thrown by the bridge instead of swallowing them', async () => {
    @Controller('/things')
    class ThingsController {}
    defineMetadata(METADATA_KEYS.CRUD, { entity: 'Thing' }, ThingsController);

    @Module({ controllers: [ThingsController] })
    class AppModule {}

    registerCrudBridge({
      buildRoutes: async () => {
        throw new Error('bridge exploded');
      },
      buildOpenApiPaths: () => ({}),
    });

    await expect(VelaFactory.create(AppModule)).rejects.toThrow(/bridge exploded/);
  });

  it('does not invoke the bridge for controllers without vela:crud metadata', async () => {
    @Controller('/plain')
    class PlainController {
      @Get() list() { return []; }
    }

    @Module({ controllers: [PlainController] })
    class AppModule {}

    const buildRoutes = vi.fn(async () => {});
    registerCrudBridge({ buildRoutes, buildOpenApiPaths: () => ({}) });

    await VelaFactory.create(AppModule);

    expect(buildRoutes).not.toHaveBeenCalled();
  });
});

describe('createOpenApiDocument — CRUD bridge integration', () => {
  it('includes paths returned by bridge.buildOpenApiPaths for controllers with vela:crud metadata', () => {
    @Controller('/users')
    class UsersController {
      @Get() hand() { return []; }
    }
    defineMetadata(METADATA_KEYS.CRUD, { entity: 'User' }, UsersController);

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const buildOpenApiPaths = vi.fn((_controller, _config, ctx: { globalPrefix: string; controllerPrefix: string }) => ({
      [`${ctx.globalPrefix}${ctx.controllerPrefix}/{id}`]: {
        get: {
          summary: 'Read one user',
          responses: { '200': { description: 'OK' } },
        },
        delete: {
          summary: 'Delete a user',
          responses: { '204': { description: 'No Content' } },
        },
      },
    }));

    registerCrudBridge({
      buildRoutes: async () => {},
      buildOpenApiPaths,
    });

    const doc = createOpenApiDocument(AppModule, { globalPrefix: '/api' });

    expect(buildOpenApiPaths).toHaveBeenCalledTimes(1);
    const [controllerArg, configArg, ctxArg] = buildOpenApiPaths.mock.calls[0]!;
    expect(controllerArg).toBe(UsersController);
    expect(configArg).toEqual({ entity: 'User' });
    expect(ctxArg).toEqual({ globalPrefix: '/api', controllerPrefix: '/users' });

    // Hand-written GET /api/users still present.
    expect(doc.paths['/api/users']?.get).toBeDefined();
    // Bridge-contributed GET + DELETE on /api/users/{id} merged in.
    expect(doc.paths['/api/users/{id}']?.get?.summary).toBe('Read one user');
    expect(doc.paths['/api/users/{id}']?.delete?.summary).toBe('Delete a user');
  });

  it('merges bridge-contributed verbs with hand-written verbs on the same path', () => {
    @Controller('/posts')
    class PostsController {
      @Get() list() { return []; }
    }
    defineMetadata(METADATA_KEYS.CRUD, { entity: 'Post' }, PostsController);

    @Module({ controllers: [PostsController] })
    class AppModule {}

    registerCrudBridge({
      buildRoutes: async () => {},
      buildOpenApiPaths: () => ({
        '/posts': {
          post: {
            summary: 'Create a post',
            responses: { '201': { description: 'Created' } },
          },
        },
      }),
    });

    const doc = createOpenApiDocument(AppModule);

    // Hand-written GET preserved, bridge POST merged in on the same path item.
    expect(doc.paths['/posts']?.get).toBeDefined();
    expect(doc.paths['/posts']?.post?.summary).toBe('Create a post');
  });

  it('works exactly as before when no bridge is registered (regression)', () => {
    @Controller('/books')
    class BooksController {
      @Get() list() { return []; }
    }
    // No bridge registered, no vela:crud metadata on this controller.

    @Module({ controllers: [BooksController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);

    expect(doc.paths['/books']?.get).toBeDefined();
    // No bridge means no extra paths beyond what the hand-written routes emit.
    expect(Object.keys(doc.paths)).toEqual(['/books']);
  });

  it('does not invoke the bridge for controllers without vela:crud metadata', () => {
    @Controller('/widgets')
    class WidgetsController {
      @Get() list() { return []; }
    }

    @Module({ controllers: [WidgetsController] })
    class AppModule {}

    const buildOpenApiPaths = vi.fn(() => ({}));
    registerCrudBridge({
      buildRoutes: async () => {},
      buildOpenApiPaths,
    });

    createOpenApiDocument(AppModule);

    expect(buildOpenApiPaths).not.toHaveBeenCalled();
  });
});
