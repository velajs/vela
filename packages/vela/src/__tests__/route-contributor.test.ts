import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Controller, Get, Module, VelaFactory } from '../index.js';
import { METADATA_KEYS, defineMetadata, Container } from '../module-kit.js';
import { createOpenApiDocument } from '../openapi/index.js';
import {
  registerRouteContributor,
  getRouteContributors,
  _resetRouteContributors,
  type RouteContributor,
} from '../http/route-contributor.js';

const contributor = (overrides: Partial<RouteContributor> = {}): RouteContributor => ({
  id: 'test-contributor',
  claimsMetaKey: METADATA_KEYS.CRUD,
  buildRoutes: async () => {},
  buildOpenApiPaths: () => ({}),
  ...overrides,
});

beforeEach(() => {
  _resetRouteContributors();
});

describe('RouteContributor registry', () => {
  it('starts empty', () => {
    expect(getRouteContributors()).toEqual([]);
  });

  it('registers and lists contributors', () => {
    const c = contributor();
    registerRouteContributor(c);
    expect(getRouteContributors()).toEqual([c]);
  });

  it('last registration per id wins (HMR re-registration)', () => {
    const first = contributor();
    const second = contributor();
    registerRouteContributor(first);
    registerRouteContributor(second);
    expect(getRouteContributors()).toEqual([second]);
  });

  it('distinct ids coexist', () => {
    const a = contributor({ id: 'a', claimsMetaKey: 'vela:a' });
    const b = contributor({ id: 'b', claimsMetaKey: 'vela:b' });
    registerRouteContributor(a);
    registerRouteContributor(b);
    expect(getRouteContributors()).toEqual([a, b]);
  });

  it('_resetRouteContributors clears everything', () => {
    registerRouteContributor(contributor());
    _resetRouteContributors();
    expect(getRouteContributors()).toEqual([]);
  });
});

describe('RouteManager — route contributor integration', () => {
  it('does not interpret unclaimed extension metadata on controllers with routes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      @Controller('/users')
      class UsersController {
        @Get('/ping') ping() {
          return { ok: true };
        }
      }
      defineMetadata(METADATA_KEYS.CRUD, { entity: 'User' }, UsersController);

      @Module({ controllers: [UsersController] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const res = await app.getHonoApp().request('/users/ping');
      expect(res.status).toBe(200);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not interpret unclaimed extension metadata on empty controllers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      @Controller('/bare')
      class BareController {}
      defineMetadata(METADATA_KEYS.CRUD, { entity: 'Bare' }, BareController);

      @Module({ controllers: [BareController] })
      class AppModule {}

      await expect(VelaFactory.create(AppModule)).resolves.toBeDefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('calls buildRoutes with the Hono app and a full context for claimed controllers', async () => {
    @Controller('/items')
    class ItemsController {}
    const crudConfig = { entity: 'Item', pagination: { defaultLimit: 25 } };
    defineMetadata(METADATA_KEYS.CRUD, crudConfig, ItemsController);

    @Module({ controllers: [ItemsController] })
    class AppModule {}

    const buildRoutes = vi.fn(async () => {});
    registerRouteContributor(contributor({ buildRoutes }));

    const app = await VelaFactory.create(AppModule, { globalPrefix: '/api' });

    expect(buildRoutes).toHaveBeenCalledTimes(1);
    const [appArg, ctxArg] = buildRoutes.mock.calls[0]! as [unknown, Record<string, unknown>];
    expect(appArg).toBe(app.getHonoApp());
    expect(ctxArg).toMatchObject({
      controller: ItemsController,
      controllerPrefix: '/items',
      meta: crudConfig,
      globalPrefix: '/api',
      globalGuards: expect.any(Array),
      joinPaths: expect.any(Function),
    });
    expect(ctxArg.container).toBeInstanceOf(Container);
    expect((ctxArg as { joinPaths: (...p: string[]) => string }).joinPaths('/api', 'users')).toBe(
      '/api/users',
    );
  });

  it('surfaces errors thrown by a contributor instead of swallowing them', async () => {
    @Controller('/things')
    class ThingsController {}
    defineMetadata(METADATA_KEYS.CRUD, { entity: 'Thing' }, ThingsController);

    @Module({ controllers: [ThingsController] })
    class AppModule {}

    registerRouteContributor(
      contributor({
        buildRoutes: async () => {
          throw new Error('contributor exploded');
        },
      }),
    );

    await expect(VelaFactory.create(AppModule)).rejects.toThrow(/contributor exploded/);
  });

  it('does not invoke a contributor for controllers without its claiming metadata', async () => {
    @Controller('/plain')
    class PlainController {
      @Get() list() {
        return [];
      }
    }

    @Module({ controllers: [PlainController] })
    class AppModule {}

    const buildRoutes = vi.fn(async () => {});
    registerRouteContributor(contributor({ buildRoutes }));

    await VelaFactory.create(AppModule);

    expect(buildRoutes).not.toHaveBeenCalled();
  });

  it('runs every contributor whose metadata a controller carries', async () => {
    @Controller('/multi')
    class MultiController {}
    defineMetadata('vela:gen-a', { a: 1 }, MultiController);
    defineMetadata('vela:gen-b', { b: 2 }, MultiController);

    @Module({ controllers: [MultiController] })
    class AppModule {}

    const aRoutes = vi.fn(async () => {});
    const bRoutes = vi.fn(async () => {});
    registerRouteContributor(
      contributor({ id: 'a', claimsMetaKey: 'vela:gen-a', buildRoutes: aRoutes }),
    );
    registerRouteContributor(
      contributor({ id: 'b', claimsMetaKey: 'vela:gen-b', buildRoutes: bRoutes }),
    );

    await VelaFactory.create(AppModule);

    expect(aRoutes).toHaveBeenCalledTimes(1);
    expect(bRoutes).toHaveBeenCalledTimes(1);
    expect(aRoutes.mock.calls[0]![1]).toMatchObject({ meta: { a: 1 } });
    expect(bRoutes.mock.calls[0]![1]).toMatchObject({ meta: { b: 2 } });
  });
});

describe('createOpenApiDocument — route contributor integration', () => {
  it('includes contributed paths for claimed controllers', () => {
    @Controller('/users')
    class UsersController {
      @Get() hand() {
        return [];
      }
    }
    defineMetadata(METADATA_KEYS.CRUD, { entity: 'User' }, UsersController);

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const buildOpenApiPaths = vi.fn((ctx: { globalPrefix: string; controllerPrefix: string }) => ({
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

    registerRouteContributor(contributor({ buildOpenApiPaths }));

    const doc = createOpenApiDocument(AppModule, { globalPrefix: '/api' });

    expect(buildOpenApiPaths).toHaveBeenCalledTimes(1);
    expect(buildOpenApiPaths.mock.calls[0]![0]).toMatchObject({
      controller: UsersController,
      meta: { entity: 'User' },
      globalPrefix: '/api',
      controllerPrefix: '/users',
    });

    // Hand-written GET /api/users still present.
    expect(doc.paths['/api/users']?.get).toBeDefined();
    // Contributed GET + DELETE on /api/users/{id} merged in.
    expect(doc.paths['/api/users/{id}']?.get?.summary).toBe('Read one user');
    expect(doc.paths['/api/users/{id}']?.delete?.summary).toBe('Delete a user');
  });

  it('merges contributed verbs with hand-written verbs on the same path', () => {
    @Controller('/posts')
    class PostsController {
      @Get() list() {
        return [];
      }
    }
    defineMetadata(METADATA_KEYS.CRUD, { entity: 'Post' }, PostsController);

    @Module({ controllers: [PostsController] })
    class AppModule {}

    registerRouteContributor(
      contributor({
        buildOpenApiPaths: () => ({
          '/posts': {
            post: {
              summary: 'Create a post',
              responses: { '201': { description: 'Created' } },
            },
          },
        }),
      }),
    );

    const doc = createOpenApiDocument(AppModule);

    expect(doc.paths['/posts']?.get).toBeDefined();
    expect(doc.paths['/posts']?.post?.summary).toBe('Create a post');
  });

  it('works exactly as before when no contributor is registered (regression)', () => {
    @Controller('/books')
    class BooksController {
      @Get() list() {
        return [];
      }
    }

    @Module({ controllers: [BooksController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);

    expect(doc.paths['/books']?.get).toBeDefined();
    expect(Object.keys(doc.paths)).toEqual(['/books']);
  });

  it('does not invoke a contributor for controllers without its claiming metadata', () => {
    @Controller('/widgets')
    class WidgetsController {
      @Get() list() {
        return [];
      }
    }

    @Module({ controllers: [WidgetsController] })
    class AppModule {}

    const buildOpenApiPaths = vi.fn(() => ({}));
    registerRouteContributor(contributor({ buildOpenApiPaths }));

    createOpenApiDocument(AppModule);

    expect(buildOpenApiPaths).not.toHaveBeenCalled();
  });
});
