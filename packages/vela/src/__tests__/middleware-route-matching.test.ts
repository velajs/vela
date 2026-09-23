import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context, type Next } from 'hono';
import { Hono as QuickHono } from 'hono/quick';
import { LinearRouter } from 'hono/router/linear-router';
import { RegExpRouter } from 'hono/router/reg-exp-router';
import { TrieRouter } from 'hono/router/trie-router';
import {
  All,
  Controller,
  Delete,
  Get,
  HttpMethod,
  Injectable,
  MetadataRegistry,
  Module,
  Post,
  VelaFactory,
  Version,
  defineMetadata,
  registerRouteContributor,
  type Constructor,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
  type RouteInfo,
  type Type,
  type VelaCreateOptions,
} from '../index';

// Consumer middleware is how applications attach authentication to a subset
// of routes, so every case here asserts that the middleware actually runs on
// the requests it was configured for — a miss is a fail-open.

let seen: string[] = [];

@Injectable()
class RecordingMiddleware implements NestMiddleware {
  async use(c: Context, next: Next) {
    seen.push(`${c.req.method} ${c.req.path}`);
    await next();
  }
}

async function createApp(
  controllers: Type[],
  configure: (consumer: MiddlewareConsumer) => void,
  options?: VelaCreateOptions,
  mountAt?: string,
  createParent: () => Hono = () => new Hono(),
) {
  @Module({ providers: [RecordingMiddleware], controllers })
  class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      configure(consumer);
    }
  }
  const app = await VelaFactory.create(AppModule, options);
  const hono =
    mountAt === undefined ? app.getHonoApp() : createParent().route(mountAt, app.getHonoApp());
  return async (method: string, path: string): Promise<number> => {
    const res = await hono.request(path, { method });
    return res.status;
  };
}

function forRoutes(...routes: Array<string | Constructor | RouteInfo>) {
  return (consumer: MiddlewareConsumer) => {
    consumer.apply(RecordingMiddleware).forRoutes(...routes);
  };
}

beforeEach(() => {
  MetadataRegistry.clear();
  seen = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('forRoutes(Controller) expands to the composed routes', () => {
  it('matches controller routes under a global prefix', async () => {
    @Controller('/admin')
    class AdminController {
      @Get()
      list() {
        return { ok: true };
      }

      @Get(':id')
      one() {
        return { ok: true };
      }
    }

    const request = await createApp([AdminController], forRoutes(AdminController), {
      globalPrefix: '/api',
    });

    expect(await request('GET', '/api/admin')).toBe(200);
    expect(await request('GET', '/api/admin/7')).toBe(200);
    expect(seen).toEqual(['GET /api/admin', 'GET /api/admin/7']);
  });

  it('matches URI-versioned controller and handler routes', async () => {
    @Controller({ path: 'admin', version: 1 })
    class AdminController {
      @Get()
      list() {
        return { ok: true };
      }

      @Get('audit')
      @Version(2)
      audit() {
        return { ok: true };
      }
    }

    const request = await createApp([AdminController], forRoutes(AdminController));

    expect(await request('GET', '/v1/admin')).toBe(200);
    expect(await request('GET', '/v2/admin/audit')).toBe(200);
    expect(seen).toEqual(['GET /v1/admin', 'GET /v2/admin/audit']);
  });

  it('matches every route of an empty-path @Controller()', async () => {
    @Controller()
    class RootController {
      @Get('status')
      status() {
        return { ok: true };
      }

      @Post('status')
      update() {
        return { ok: true };
      }
    }

    @Controller('/public')
    class PublicController {
      @Get()
      open() {
        return { ok: true };
      }
    }

    const request = await createApp([RootController, PublicController], forRoutes(RootController));

    expect(await request('GET', '/status')).toBe(200);
    expect(await request('POST', '/status')).toBe(200);
    expect(await request('GET', '/public')).toBe(200);
    expect(seen).toEqual(['GET /status', 'POST /status']);
  });

  it("uses each handler's method, including HEAD served by a GET handler", async () => {
    @Controller('/shared')
    class WriteController {
      @Post()
      write() {
        return { ok: true };
      }

      @Get('report')
      report() {
        return { ok: true };
      }
    }

    @Controller('/shared')
    class ReadController {
      @Get()
      read() {
        return { ok: true };
      }
    }

    const request = await createApp([WriteController, ReadController], forRoutes(WriteController));

    expect(await request('GET', '/shared')).toBe(200);
    expect(await request('POST', '/shared')).toBe(200);
    expect(await request('HEAD', '/shared/report')).toBe(200);
    expect(seen).toEqual(['POST /shared', 'HEAD /shared/report']);
  });

  it('matches a controller route registered with a trailing slash', async () => {
    @Controller('/cats')
    class CatsController {
      @Get('/')
      list() {
        return { ok: true };
      }
    }

    const request = await createApp([CatsController], (consumer) => {
      consumer.apply(RecordingMiddleware).forRoutes(CatsController);
    });

    const status = await request('GET', '/cats/');
    expect(status).toBe(200);
    expect(seen).toEqual(['GET /cats/']);
  });

  it('keeps a trailing slash significant in exclude() targets', async () => {
    @Controller('/cats')
    class CatsController {
      @Get('/')
      slashed() {
        return { ok: true };
      }
    }

    @Controller('/dogs')
    class DogsController {
      @Get()
      bare() {
        return { ok: true };
      }
    }

    const request = await createApp([CatsController, DogsController], (consumer) => {
      consumer.apply(RecordingMiddleware).exclude('cats/', 'dogs/').forRoutes('*');
    });

    expect(await request('GET', '/cats/')).toBe(200);
    expect(await request('GET', '/dogs')).toBe(200);
    expect(seen).toEqual(['GET /dogs']);
  });

  it('rejects a controller that declares no routes instead of matching nothing', async () => {
    @Controller('/empty')
    class EmptyController {
      describe() {
        return 'not a route';
      }
    }

    await expect(createApp([EmptyController], forRoutes(EmptyController))).rejects.toThrow(
      /EmptyController declares no routes/,
    );
  });
});

describe('forRoutes(string | RouteInfo) uses literal and parameter segments', () => {
  it('applies the global prefix to string routes', async () => {
    @Controller('/admin')
    class AdminController {
      @Get('users')
      users() {
        return { ok: true };
      }
    }

    const request = await createApp([AdminController], forRoutes('/admin'), {
      globalPrefix: '/api',
    });

    expect(await request('GET', '/api/admin/users')).toBe(200);
    expect(seen).toEqual(['GET /api/admin/users']);
  });

  it("matches ':param' segments in string routes", async () => {
    @Controller('/users')
    class UsersController {
      @Get()
      list() {
        return { ok: true };
      }

      @Get(':id')
      one() {
        return { ok: true };
      }
    }

    const request = await createApp([UsersController], forRoutes('users/:id'));

    expect(await request('GET', '/users')).toBe(200);
    expect(await request('GET', '/users/42')).toBe(200);
    expect(seen).toEqual(['GET /users/42']);
  });

  it('filters a RouteInfo by method under the global prefix', async () => {
    @Controller('/items')
    class ItemsController {
      @Get(':id')
      one() {
        return { ok: true };
      }

      @Delete(':id')
      remove() {
        return { ok: true };
      }
    }

    const request = await createApp(
      [ItemsController],
      forRoutes({ path: 'items/:id', method: HttpMethod.DELETE }),
      { globalPrefix: '/api' },
    );

    expect(await request('GET', '/api/items/1')).toBe(200);
    expect(await request('DELETE', '/api/items/1')).toBe(200);
    expect(seen).toEqual(['DELETE /api/items/1']);
  });

  it('covers HEAD requests with a GET RouteInfo because Hono serves them with the GET handler', async () => {
    @Controller('/reports')
    class ReportsController {
      @Get()
      list() {
        return { ok: true };
      }
    }

    const request = await createApp(
      [ReportsController],
      forRoutes({ path: '/reports', method: HttpMethod.GET }),
    );

    expect(await request('HEAD', '/reports')).toBe(200);
    expect(seen).toEqual(['HEAD /reports']);
  });

  it("keeps '*' matching every request, even under a global prefix", async () => {
    @Controller('/admin')
    class AdminController {
      @Get()
      list() {
        return { ok: true };
      }
    }

    const request = await createApp([AdminController], forRoutes('*'), { globalPrefix: '/api' });

    expect(await request('GET', '/api/admin')).toBe(200);
    expect(await request('GET', '/elsewhere')).toBe(404);
    expect(seen).toEqual(['GET /api/admin', 'GET /elsewhere']);
  });

  // A target that repeats the prefix would resolve to '/api/api/...' and never
  // match, so the build fails instead of leaving the routes unprotected.
  it.each<{ name: string; routes: Array<string | RouteInfo> }>([
    { name: 'a string route', routes: ['/api/admin'] },
    { name: 'a RouteInfo', routes: [{ path: 'api/admin/:id', method: HttpMethod.GET }] },
    { name: 'the bare prefix', routes: ['/api'] },
  ])('rejects $name that already carries the global prefix', async ({ routes }) => {
    @Controller('/admin')
    class AdminController {
      @Get()
      list() {
        return { ok: true };
      }
    }

    await expect(
      createApp([AdminController], forRoutes(...routes), { globalPrefix: '/api' }),
    ).rejects.toThrow(/already includes the global prefix '\/api'.*absolute: true/);
  });

  it('rejects an exclude() target that already carries the global prefix', async () => {
    @Controller('/admin')
    class AdminController {
      @Get()
      list() {
        return { ok: true };
      }
    }

    await expect(
      createApp(
        [AdminController],
        (consumer) => {
          consumer.apply(RecordingMiddleware).exclude('/api/admin').forRoutes(AdminController);
        },
        { globalPrefix: '/api/' },
      ),
    ).rejects.toThrow(/'\/api\/admin' already includes the global prefix '\/api'/);
  });

  it('accepts a route that only shares leading characters with the global prefix', async () => {
    @Controller('/api-keys')
    class KeysController {
      @Get()
      list() {
        return { ok: true };
      }
    }

    const request = await createApp([KeysController], forRoutes('/api-keys'), {
      globalPrefix: '/api',
    });

    expect(await request('GET', '/api/api-keys')).toBe(200);
    expect(seen).toEqual(['GET /api/api-keys']);
  });
});

// Platform routes such as an RPC endpoint, WebSocket upgrades and OpenAPI
// documents are registered outside the global prefix.
describe('absolute RouteInfo targets skip the global prefix', () => {
  async function createPlatformApp(configure: (consumer: MiddlewareConsumer) => void) {
    @Controller('/admin')
    class AdminController {
      @Get(':id')
      one() {
        return { ok: true };
      }
    }

    @Module({ providers: [RecordingMiddleware], controllers: [AdminController] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        configure(consumer);
      }
    }
    const app = await VelaFactory.create(AppModule, { globalPrefix: '/api' });
    const hono = app.getHonoApp();
    hono.post('/rpc', (c) => c.json({ ok: true }));
    hono.get('/rpc/manifest', (c) => c.json({ ok: true }));
    return async (method: string, path: string): Promise<number> =>
      (await hono.request(path, { method })).status;
  }

  it('matches a route served outside the global prefix, and the paths beneath it', async () => {
    const request = await createPlatformApp((consumer) => {
      consumer.apply(RecordingMiddleware).forRoutes({ path: '/rpc', absolute: true });
    });

    expect(await request('POST', '/rpc')).toBe(200);
    expect(await request('GET', '/rpc/manifest')).toBe(200);
    expect(await request('GET', '/api/admin/1')).toBe(200);
    expect(seen).toEqual(['POST /rpc', 'GET /rpc/manifest']);
  });

  it('keeps a relative target under the global prefix and reports that it matches no route', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = await createPlatformApp((consumer) => {
      consumer.apply(RecordingMiddleware).forRoutes('/rpc');
    });

    expect(await request('POST', '/rpc')).toBe(200);
    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[vela] Middleware route '/rpc' resolves to '/api/rpc', which matches no route " +
        'registered at startup, so the middleware never runs for it. For a route added to the ' +
        'Hono app later (mountOpenApi(), WebSocket upgrades, app.getHonoApp()), pass the path ' +
        "it is served on with absolute: true, such as { path: '/api/rpc', absolute: true }.",
    );
  });

  it('keeps absolute targets out of the startup route check', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createPlatformApp((consumer) => {
      consumer.apply(RecordingMiddleware).forRoutes({ path: '/rpc', absolute: true });
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('filters by method and accepts a path that starts with the global prefix', async () => {
    const request = await createPlatformApp((consumer) => {
      consumer
        .apply(RecordingMiddleware)
        .exclude({ path: '/api/admin/0', absolute: true })
        .forRoutes(
          { path: '/rpc', method: HttpMethod.POST, absolute: true },
          { path: '/api/admin/:id', absolute: true },
        );
    });

    expect(await request('POST', '/rpc')).toBe(200);
    expect(await request('GET', '/rpc/manifest')).toBe(200);
    expect(await request('GET', '/api/admin/0')).toBe(200);
    expect(await request('GET', '/api/admin/7')).toBe(200);
    expect(seen).toEqual(['POST /rpc', 'GET /api/admin/7']);
  });
});

describe('exclude() is an exact route-pattern match', () => {
  it('does not exclude routes nested below an excluded path', async () => {
    @Controller('/files')
    class FilesController {
      @Get('public')
      open() {
        return { ok: true };
      }

      @Get('public/secret')
      secret() {
        return { ok: true };
      }
    }

    const request = await createApp([FilesController], (consumer) => {
      consumer.apply(RecordingMiddleware).exclude('/files/public').forRoutes(FilesController);
    });

    expect(await request('GET', '/files/public')).toBe(200);
    expect(await request('GET', '/files/public/secret')).toBe(200);
    expect(seen).toEqual(['GET /files/public/secret']);
  });

  it('resolves excluded routes under the global prefix and matches params', async () => {
    @Controller('/docs')
    class DocsController {
      @Get('health')
      health() {
        return { ok: true };
      }

      @Get(':slug')
      page() {
        return { ok: true };
      }

      @Get(':slug/edit')
      edit() {
        return { ok: true };
      }
    }

    const request = await createApp(
      [DocsController],
      (consumer) => {
        consumer
          .apply(RecordingMiddleware)
          .exclude('/docs/health', { path: '/docs/:slug', method: HttpMethod.GET })
          .forRoutes(DocsController);
      },
      { globalPrefix: '/api' },
    );

    expect(await request('GET', '/api/docs/health')).toBe(200);
    expect(await request('GET', '/api/docs/intro')).toBe(200);
    expect(await request('GET', '/api/docs/intro/edit')).toBe(200);
    expect(seen).toEqual(['GET /api/docs/intro/edit']);
  });
});

describe('an app mounted under a parent base path', () => {
  it('matches relative to the base path of a parent app that mounts it', async () => {
    @Controller('/admin')
    class AdminController {
      @Get(':id')
      one() {
        return { ok: true };
      }
    }

    const request = await createApp(
      [AdminController],
      (consumer) => {
        consumer.apply(RecordingMiddleware).exclude('/admin/0').forRoutes(AdminController);
      },
      { globalPrefix: '/api' },
      '/mounted',
    );

    expect(await request('GET', '/mounted/api/admin/0')).toBe(200);
    expect(await request('GET', '/mounted/api/admin/7')).toBe(200);
    expect(seen).toEqual(['GET /mounted/api/admin/7']);
  });

  @Controller('/auth')
  class AuthController {
    @Get('login')
    login() {
      return { ok: true };
    }
  }

  @Controller('/admin')
  class SecretsController {
    @Get('secrets')
    secrets() {
      return { ok: true };
    }
  }

  @Controller('/users')
  class UsersController {
    @Get(':id')
    one() {
      return { ok: true };
    }
  }

  // Hono's basePath() helper cannot measure a base whose constraint rejects
  // the rest of the path, so a request's own path must never be re-derived.
  it('matches under a base with a regex-constrained parameter', async () => {
    const base = '/:tenant{[a-z0-9-]+}';
    const controllers = [AuthController, SecretsController, UsersController];
    const excluded = await createApp(
      controllers,
      (consumer) => {
        consumer.apply(RecordingMiddleware).exclude('auth/*').forRoutes('*');
      },
      undefined,
      base,
    );

    expect(await excluded('GET', '/auth/admin/secrets')).toBe(200);
    expect(await excluded('GET', '/acme/auth/login')).toBe(200);
    expect(seen).toEqual(['GET /auth/admin/secrets']);

    seen = [];
    const scoped = await createApp(controllers, forRoutes('users'), undefined, base);
    expect(await scoped('GET', '/acme/users/7')).toBe(200);
    expect(await scoped('GET', '/users/users/7')).toBe(200);
    expect(await scoped('GET', '/acme/admin/secrets')).toBe(200);
    expect(seen).toEqual(['GET /acme/users/7', 'GET /users/users/7']);
  });

  it.each(['/m/', '/:tenant/'])('matches under the trailing-slash base %s', async (base) => {
    const prefix = base === '/m/' ? '/m' : '/acme';
    const request = await createApp(
      [AuthController, UsersController],
      (consumer) => {
        consumer.apply(RecordingMiddleware).exclude('users/:id').forRoutes('auth', 'users');
      },
      undefined,
      base,
    );

    expect(await request('GET', `${prefix}/auth/login`)).toBe(200);
    expect(await request('GET', `${prefix}/users/7`)).toBe(200);
    expect(seen).toEqual([`GET ${prefix}/auth/login`]);
  });

  async function createModule(configure: (consumer: MiddlewareConsumer) => void) {
    @Module({
      providers: [RecordingMiddleware],
      controllers: [AuthController, SecretsController, UsersController],
    })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        configure(consumer);
      }
    }
    return (await VelaFactory.create(AppModule)).getHonoApp();
  }

  function excludeUser(consumer: MiddlewareConsumer) {
    consumer.apply(RecordingMiddleware).exclude('users/:id').forRoutes('*');
  }

  it('matches relative to each base when two nested parents mount the app', async () => {
    const app = await createModule(excludeUser);
    const outer = new Hono().route('/outer', new Hono().route('/:tenant', app));

    for (const path of [
      '/outer/acme/users/7',
      '/outer/acme/admin/secrets',
      '/outer/users/users/7',
    ]) {
      expect((await outer.request(path)).status).toBe(200);
    }
    expect(seen).toEqual(['GET /outer/acme/admin/secrets']);
  });

  it('matches relative to the base of the mount that serves the request', async () => {
    const app = await createModule(excludeUser);
    const parent = new Hono().route('/a', app).route('/:tenant{[a-z]+}/b', app);

    for (const path of ['/a/users/7', '/x/b/users/7', '/a/admin/secrets', '/x/b/auth/login']) {
      expect((await parent.request(path)).status).toBe(200);
    }
    expect(seen).toEqual(['GET /a/admin/secrets', 'GET /x/b/auth/login']);
  });

  // A decoded parameter no longer spells the path it was matched from, so the
  // base cannot be measured and exclude() targets are not trusted.
  it.each(['/a%3Ab', '/a%25b', '/a%2Fb'])(
    'runs the middleware, ignoring exclude() targets, under a base parameter %s',
    async (tenant) => {
      const app = await createModule(excludeUser);
      const parent = new Hono().route('/:tenant', app);

      expect((await parent.request(`${tenant}/users/7`)).status).toBe(200);
      expect((await parent.request('/acme/users/7')).status).toBe(200);
      expect(seen).toEqual([`GET ${tenant}/users/7`]);
    },
  );

  // A trailing-slash base puts the app's root at '/m/', so '/m' lies outside it.
  it("runs the middleware for the base itself under a trailing-slash base '/m/'", async () => {
    @Controller()
    class CatchAllController {
      @Get('*')
      any() {
        return { ok: true };
      }
    }

    const request = await createApp(
      [CatchAllController],
      (consumer) => {
        consumer.apply(RecordingMiddleware).exclude('/', 'x').forRoutes('*');
      },
      undefined,
      '/m/',
    );

    expect(await request('GET', '/m')).toBe(200);
    expect(await request('GET', '/m/')).toBe(200);
    expect(await request('GET', '/m/x')).toBe(200);
    expect(await request('GET', '/m/y')).toBe(200);
    expect(seen).toEqual(['GET /m', 'GET /m/y']);
  });

  // Path targets no longer register routes on the Vela app, so a parent app
  // on any of Hono's routers can mount it.
  it.each([
    ['RegExpRouter', () => new Hono({ router: new RegExpRouter() })],
    ['LinearRouter', () => new Hono({ router: new LinearRouter() })],
  ] as const)('is mounted by a parent app on the %s', async (_name, createParent) => {
    const app = await createModule((consumer) => {
      consumer.apply(RecordingMiddleware).exclude('users/:id').forRoutes('users', 'auth/login');
    });
    const parent = createParent().route('/m', app);

    for (const path of ['/m/users/7', '/m/auth/login', '/m/admin/secrets']) {
      expect((await parent.request(path)).status).toBe(200);
    }
    expect(seen).toEqual(['GET /m/auth/login']);
  });

  // A '{regex}' base parameter that can span '/' reads differently for the
  // running middleware and for the route that serves the request: under
  // '/:org{.+}' Hono gives the middleware 'acme/admin' for /acme/admin and the
  // route 'acme'. Such a base is never measured, so the request fails closed.
  describe.each(['/:org{.+}', '/:org{.+?}', '/:org{(?:[a-z]+/)?[a-z]+}'])(
    'under the base %s, whose parameter can span a slash',
    (base) => {
      @Controller('/admin')
      class AdminController {
        @Get()
        list() {
          return { ok: true };
        }

        @Get(':id')
        one() {
          return { ok: true };
        }
      }

      const paths = ['/acme/admin', '/acme/team/admin', '/acme/admin/7'];

      it('runs forRoutes() middleware for every route beneath the target', async () => {
        const request = await createApp(
          [AdminController],
          forRoutes('admin'),
          undefined,
          base,
          () => new Hono({ router: new TrieRouter() }),
        );

        for (const path of paths) expect(await request('GET', path)).toBe(200);
        expect(seen).toEqual(paths.map((path) => `GET ${path}`));
      });

      it('ignores exclude() path targets', async () => {
        const request = await createApp(
          [AdminController],
          (consumer) => {
            consumer.apply(RecordingMiddleware).exclude('admin', 'admin/:id').forRoutes('*');
          },
          undefined,
          base,
          () => new Hono({ router: new TrieRouter() }),
        );

        for (const path of paths) expect(await request('GET', path)).toBe(200);
        expect(seen).toEqual(paths.map((path) => `GET ${path}`));
      });
    },
  );

  // Hono's TrieRouter serves a mounted app's routes under a base whose
  // '{regex}' parameter must span '/', but never runs the app's '*'
  // middleware, so body limits and consumer middleware would all be skipped.
  it('answers 500 when a parent serves a route without the Vela middleware chain', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await createModule(forRoutes('admin'));
    const parent = new Hono({ router: new TrieRouter() }).route('/:org{[a-z]+/[a-z]+}', app);

    const response = await parent.request('/acme/team/admin/secrets');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 'internal', message: 'Internal Server Error' },
    });
    expect(seen).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('GET /acme/team/admin/secrets'),
      expect.objectContaining({
        message: expect.stringContaining('Vela middleware chain did not run — unsupported mount'),
      }),
    );
  });
});

// Path targets are decided by Vela's own matcher, never by routes added to the
// application: the app keeps the router its own routes choose.
describe('path targets leave the application routes alone', () => {
  // A literal beside ':id' would make Hono fall back to its TrieRouter.
  @Controller('/users')
  class UsersController {
    @Get(':id')
    one() {
      return { ok: true };
    }

    @Get(':id/posts/:post')
    post() {
      return { ok: true };
    }
  }

  async function createModuleApp(configure: (consumer: MiddlewareConsumer) => void) {
    @Module({ providers: [RecordingMiddleware], controllers: [UsersController] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        configure(consumer);
      }
    }
    return (await VelaFactory.create(AppModule, { globalPrefix: '/api' })).getHonoApp();
  }

  it('registers no route for a target and keeps the RegExpRouter', async () => {
    const plain = await createModuleApp((consumer) => {
      consumer.apply(RecordingMiddleware).forRoutes(UsersController);
    });
    const app = await createModuleApp((consumer) => {
      consumer
        .apply(RecordingMiddleware)
        .exclude('users/me', { path: '/rpc', absolute: true })
        .forRoutes('users', 'users/:id/posts', { path: '/rpc', absolute: true });
    });

    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual(
      plain.routes.map(({ method, path }) => `${method} ${path}`),
    );
    expect((await app.request('/api/users/7/posts/9')).status).toBe(200);
    expect((await app.request('/api/users/me')).status).toBe(200);
    expect(app.router.name).toBe('SmartRouter + RegExpRouter');
    expect(seen).toEqual(['GET /api/users/7/posts/9']);
  });

  it("keeps exclude('auth/login') exact beside a longer segment", async () => {
    @Controller('/auth')
    class AuthController {
      @Get('login')
      login() {
        return { ok: true };
      }

      @Get('login-as/:id')
      impersonate() {
        return { ok: true };
      }
    }

    const request = await createApp([AuthController], (consumer) => {
      consumer.apply(RecordingMiddleware).exclude('auth/login', 'auth/register').forRoutes('*');
    });

    expect(await request('GET', '/auth/login')).toBe(200);
    expect(await request('GET', '/auth/login-as/42')).toBe(200);
    expect(seen).toEqual(['GET /auth/login-as/42']);
  });

  // A route contributor may refuse to register over an existing route, as the
  // RPC endpoint does, so a target for its path must not be a route itself.
  it('lets a contributor register a route that an absolute target names', async () => {
    const CONFLICT_CHECKED = 'test:middleware-conflict-checked-route';
    registerRouteContributor({
      id: CONFLICT_CHECKED,
      claimsMetaKey: CONFLICT_CHECKED,
      buildRoutes(app, context) {
        const path = String(context.meta);
        if (app.routes.some((route) => route.path === path && route.method === 'ALL')) {
          throw new Error(`Route conflicts with existing route '${path}'`);
        }
        app.post(path, (c) => c.json({ ok: true }));
      },
    });
    @Controller('')
    class RpcEndpoint {}
    defineMetadata(CONFLICT_CHECKED, '/rpc', RpcEndpoint);

    for (const globalPrefix of [undefined, '/api']) {
      seen = [];
      const request = await createApp(
        [RpcEndpoint],
        forRoutes({ path: '/rpc', absolute: true }),
        globalPrefix === undefined ? undefined : { globalPrefix },
      );
      expect(await request('POST', '/rpc')).toBe(200);
      expect(seen).toEqual(['POST /rpc']);
    }
  });
});

describe('parameter targets match one whole segment', () => {
  it("runs beneath a ':id' target for a deeper route written with '*'", async () => {
    @Controller('/users')
    class PostsController {
      @Get(':id/posts/:post')
      one() {
        return { ok: true };
      }
    }

    @Controller('/files')
    class RawController {
      @Get('*/raw/:name')
      one() {
        return { ok: true };
      }
    }

    const request = await createApp(
      [PostsController, RawController],
      forRoutes('users/:id/posts', 'files/:id/raw'),
    );

    expect(await request('GET', '/users/7/posts/9')).toBe(200);
    expect(await request('GET', '/files/7/raw/9')).toBe(200);
    expect(seen).toEqual(['GET /users/7/posts/9', 'GET /files/7/raw/9']);
  });

  it("never matches an empty segment with ':id'", async () => {
    // A literal beside '*' makes Hono fall back to its TrieRouter, where '*'
    // before the last segment also matches an empty segment.
    @Controller('/files')
    class FilesController {
      @Get('*/raw')
      raw() {
        return { ok: true };
      }

      @Get('static/raw')
      fixed() {
        return { ok: true };
      }
    }

    const request = await createApp([FilesController], (consumer) => {
      consumer.apply(RecordingMiddleware).exclude('files/:id/raw').forRoutes('*');
    });

    expect(await request('GET', '/files//raw')).toBe(200);
    expect(await request('GET', '/files/a/raw')).toBe(200);
    expect(seen).toEqual(['GET /files//raw']);
  });
});

// Hono's LinearRouter, which 'hono/quick' uses, serves ':org' on an empty
// segment, so a parent on it serves '/app//settings' with the route
// '/:org/settings'. forRoutes() reads ':name' as broadly and fails closed;
// exclude() keeps ':name' to non-empty segments, so it fails closed too.
describe("forRoutes() ':name' segments also match an empty segment", () => {
  const parents = [
    ['LinearRouter', () => new Hono({ router: new LinearRouter() })],
    ['hono/quick', () => new QuickHono()],
  ] as const;

  @Controller(':org')
  class OrgSettingsController {
    @Get('settings')
    settings() {
      return { ok: true };
    }
  }

  @Controller('settings')
  class SettingsController {
    @Get()
    settings() {
      return { ok: true };
    }
  }

  function excludeSettings(target: string) {
    return (consumer: MiddlewareConsumer) => {
      consumer.apply(RecordingMiddleware).exclude(target).forRoutes('*');
    };
  }

  it.each(parents)(
    "runs forRoutes(':org/settings') for an empty segment a %s parent serves",
    async (_name, createParent) => {
      const request = await createApp(
        [OrgSettingsController],
        forRoutes(':org/settings'),
        undefined,
        '/app',
        createParent,
      );

      expect(await request('GET', '/app//settings')).toBe(200);
      expect(await request('GET', '/app/acme/settings')).toBe(200);
      expect(seen).toEqual(['GET /app//settings', 'GET /app/acme/settings']);
    },
  );

  it.each(parents)(
    "keeps exclude(':org/settings') to non-empty segments under a %s parent",
    async (_name, createParent) => {
      const request = await createApp(
        [OrgSettingsController],
        excludeSettings(':org/settings'),
        undefined,
        '/app',
        createParent,
      );

      expect(await request('GET', '/app//settings')).toBe(200);
      expect(await request('GET', '/app/acme/settings')).toBe(200);
      expect(seen).toEqual(['GET /app//settings']);
    },
  );

  it.each(parents)(
    'reads a global prefix parameter the same way under a %s parent',
    async (_name, createParent) => {
      const options = { globalPrefix: '/:tenant' };
      const scoped = await createApp(
        [SettingsController],
        forRoutes('settings'),
        options,
        '/app',
        createParent,
      );
      expect(await scoped('GET', '/app//settings')).toBe(200);
      expect(await scoped('GET', '/app/acme/settings')).toBe(200);
      expect(seen).toEqual(['GET /app//settings', 'GET /app/acme/settings']);

      seen = [];
      const excluded = await createApp(
        [SettingsController],
        excludeSettings('settings'),
        options,
        '/app',
        createParent,
      );
      expect(await excluded('GET', '/app//settings')).toBe(200);
      expect(await excluded('GET', '/app/acme/settings')).toBe(200);
      expect(seen).toEqual(['GET /app//settings']);
    },
  );
});

// Path targets use a small grammar that Vela matches segment by segment:
// literal segments, ':name' with an identifier name and a trailing wildcard.
// Everything else fails the route build with its cause instead of matching
// what one router or another makes of it.
describe('target syntax outside the grammar fails the route build', () => {
  @Controller('/files')
  class FilesController {
    @Get(':a/:b/:c')
    nested() {
      return { ok: true };
    }
  }

  async function expectRejected(target: string, message: string) {
    const expected = `Middleware route '${target}' ${message}`;
    await expect(createApp([FilesController], forRoutes(target))).rejects.toThrow(expected);
    await expect(
      createApp([FilesController], (consumer) => {
        consumer.apply(RecordingMiddleware).exclude(target).forRoutes('*');
      }),
    ).rejects.toThrow(expected);
  }

  // Hono's TrieRouter anchors only the first and last alternative of a
  // top-level '|', so 'auth/:action{login|register}' also matched
  // '/auth/login-as/42', and constraints that span segments backtrack there.
  it.each([
    'auth/:action{login|register}',
    'users/:id{\\d+|me}',
    'cats/:id{[0-9]+}',
    'users/:id{[0-9]+}',
    'files/:a{[\\s\\S]+}/:b{[\\s\\S]+}/x',
    'cats/:id{[0-9}',
    'cats/:id{[0-9]*}',
  ])("rejects the '{regex}' constraint in '%s'", async (target) => {
    await expectRejected(
      target,
      "uses a '{regex}' constraint: use ':name' or target the controller",
    );
  });

  it.each([':id?', 'users/:id?', 'files/*/:id?', 'files/a?b'])(
    "rejects the optional '?' in '%s'",
    async (target) => {
      await expectRejected(target, "uses an optional '?': list each path or target the controller");
    },
  );

  it.each([
    'files/*/raw',
    '*/*',
    'users/*/posts',
    'files/*a/*b',
    'files/(.*)/(.*)',
    'files/*a/{*b}',
    'files/(.*)/x/*b',
    'files/*a/*',
    'files/*a/b*',
  ])("rejects the wildcard before the last segment of '%s'", async (target) => {
    await expectRejected(target, 'has a wildcard before its last segment');
  });

  const SEGMENT_SYNTAX =
    "puts '*' or ':' inside a segment, or names a parameter that is not an identifier: use " +
    "a whole ':name' segment, list the paths, or target the controller.";

  // Hono's routers disagree on whether 'abc:name' is text or a parameter.
  it.each(['admin/us*', 'cats/ab*cd', 'files/abc:name', 'files/:a/abc:name', 'a:b', 'files/v1:*'])(
    "rejects the '*' or ':' inside a segment of '%s'",
    async (target) => {
      await expectRejected(target, SEGMENT_SYNTAX);
    },
  );

  // Hono's PatternRouter reads ':name.pdf' as the parameter ':name' followed
  // by the text '.pdf'; its other routers read the whole segment.
  it.each([':name.pdf', 'files/:from-to', 'files/:x@1', 'files/:1st', 'files/:', ':a/:b.c/d'])(
    "rejects the parameter name that is not an identifier in '%s'",
    async (target) => {
      await expectRejected(target, SEGMENT_SYNTAX);
    },
  );

  it.each(['files/:é', 'files/:$id', 'files/:_id', 'files/:id2/raw'])(
    "accepts the identifier parameter name in '%s'",
    async (target) => {
      await expect(createApp([FilesController], forRoutes(target))).resolves.toBeTypeOf('function');
    },
  );

  it.each(['cats/:id(\\d+)', 'cats{/:id}', 'cats/(a|b)', 'cats/{id}', 'cats/{*}'])(
    "rejects the group in '%s'",
    async (target) => {
      await expectRejected(target, 'uses a group');
    },
  );

  it.each(['cats//toys', '//cats', 'cats//'])(
    "rejects the empty segment in '%s'",
    async (target) => {
      await expectRejected(target, 'has an empty segment');
    },
  );
});

// A route contributor registers its routes during route build, outside the
// global prefix, like the RPC endpoint or the Studio surface.
const PLATFORM_ROUTE = 'test:middleware-platform-route';
registerRouteContributor({
  id: PLATFORM_ROUTE,
  claimsMetaKey: PLATFORM_ROUTE,
  buildRoutes(app, context) {
    app.post(String(context.meta), (c) => c.json({ ok: true }));
  },
});

describe('relative targets are checked against the routes registered at startup', () => {
  function platformEndpoint(path: string): Type {
    @Controller('')
    class PlatformEndpoint {}
    defineMetadata(PLATFORM_ROUTE, path, PlatformEndpoint);
    return PlatformEndpoint;
  }

  @Controller('/users')
  class UsersController {
    @Get(':id')
    one() {
      return { ok: true };
    }
  }

  it.each<{ name: string; configure: (consumer: MiddlewareConsumer) => void }>([
    {
      name: 'forRoutes()',
      configure: (consumer) => {
        consumer.apply(RecordingMiddleware).forRoutes('platform');
      },
    },
    {
      name: 'exclude()',
      configure: (consumer) => {
        consumer.apply(RecordingMiddleware).exclude('platform').forRoutes('*');
      },
    },
  ])(
    'rejects a $name target for a route served outside the global prefix',
    async ({ configure }) => {
      await expect(
        createApp([UsersController, platformEndpoint('/platform')], configure, {
          globalPrefix: '/api',
        }),
      ).rejects.toThrow(
        "Middleware route 'platform' resolves to '/api/platform' under the global prefix " +
          "'/api', which serves no route, but '/platform' is served outside the prefix. Pass " +
          "{ path: '/platform', absolute: true } to match it as written.",
      );
    },
  );

  it('accepts a relative target served under the global prefix', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = await createApp(
      [UsersController, platformEndpoint('/platform')],
      (consumer) => {
        consumer
          .apply(RecordingMiddleware)
          .forRoutes('users/42', { path: '/platform', absolute: true });
      },
      { globalPrefix: '/api', diagnostics: 'throw' },
    );

    expect(await request('GET', '/api/users/42')).toBe(200);
    expect(await request('POST', '/platform')).toBe(200);
    expect(seen).toEqual(['GET /api/users/42', 'POST /platform']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails bootstrap in diagnostics throw mode for a target that matches no route', async () => {
    await expect(
      createApp([UsersController], forRoutes('accounts'), { diagnostics: 'throw' }),
    ).rejects.toThrow("[vela] Middleware route 'accounts' resolves to '/accounts'");
  });

  // Following the suggestion must keep the middleware on the path the target
  // resolves to, so it never drops the global prefix.
  it('suggests an absolute target that keeps the global prefix', async () => {
    await expect(
      createApp([UsersController], forRoutes('accounts/:id'), {
        globalPrefix: '/api',
        diagnostics: 'throw',
      }),
    ).rejects.toThrow(
      "[vela] Middleware route 'accounts/:id' resolves to '/api/accounts/:id', which matches " +
        'no route registered at startup, so the middleware never runs for it. For a route ' +
        'added to the Hono app later (mountOpenApi(), WebSocket upgrades, app.getHonoApp()), ' +
        "pass the path it is served on with absolute: true, such as { path: '/api/accounts/:id', " +
        'absolute: true }.',
    );
  });

  // A target reaches a route when their segments line up, reading each
  // constrained route parameter as one segment: no sample value has to satisfy
  // the constraint.
  it('reaches routes whose parameters carry a regex constraint', async () => {
    @Controller('/accounts')
    class AccountsController {
      @Get(':id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}')
      one() {
        return { ok: true };
      }
    }

    @Controller('/images')
    class ImagesController {
      @Get(':file{.+\\.png}')
      one() {
        return { ok: true };
      }
    }

    const id = '123e4567-e89b-12d3-a456-426614174000';
    const request = await createApp(
      [AccountsController, ImagesController],
      forRoutes('accounts/:id', 'images/:file', 'images'),
      { globalPrefix: '/api', diagnostics: 'throw' },
    );

    expect(await request('GET', `/api/accounts/${id}`)).toBe(200);
    expect(await request('GET', '/api/images/cat.png')).toBe(200);
    expect(seen).toEqual([`GET /api/accounts/${id}`, 'GET /api/images/cat.png']);
  });
});

describe('Nest wildcard targets', () => {
  @Controller('/cats')
  class CatsController {
    @Get(':id')
    one() {
      return { ok: true };
    }

    @Get(':id/toys')
    toys() {
      return { ok: true };
    }
  }

  @Controller('/dogs')
  class DogsController {
    @Get(':id')
    one() {
      return { ok: true };
    }
  }

  @Controller('/cats')
  class CatsWithIndexController {
    @Get()
    list() {
      return { ok: true };
    }

    @Get(':id')
    one() {
      return { ok: true };
    }

    @Get(':owner/:id/toys')
    ownedToys() {
      return { ok: true };
    }
  }

  it.each(['cats/*path', 'cats/(.*)'])(
    "translates '%s' to a wildcard that needs at least one segment below /cats",
    async (target) => {
      const request = await createApp(
        [CatsWithIndexController, CatsController, DogsController],
        forRoutes(target),
        { globalPrefix: '/api' },
      );

      expect(await request('GET', '/api/cats')).toBe(200);
      expect(await request('GET', '/api/cats/1')).toBe(200);
      expect(await request('GET', '/api/cats/1/toys')).toBe(200);
      expect(await request('GET', '/api/dogs/1')).toBe(200);
      expect(seen).toEqual(['GET /api/cats/1', 'GET /api/cats/1/toys']);
    },
  );

  it.each(['cats/{*splat}', 'cats/*'])(
    "translates '%s' to a trailing Hono wildcard that also matches /cats",
    async (target) => {
      const request = await createApp(
        [CatsWithIndexController, CatsController, DogsController],
        forRoutes(target),
        { globalPrefix: '/api' },
      );

      expect(await request('GET', '/api/cats')).toBe(200);
      expect(await request('GET', '/api/cats/1')).toBe(200);
      expect(await request('GET', '/api/cats/1/toys')).toBe(200);
      expect(await request('GET', '/api/dogs/1')).toBe(200);
      expect(seen).toEqual(['GET /api/cats', 'GET /api/cats/1', 'GET /api/cats/1/toys']);
    },
  );

  it.each(['cats/*path', 'cats/(.*)'])(
    "keeps running middleware on /cats itself when '%s' is excluded",
    async (target) => {
      const request = await createApp([CatsWithIndexController, DogsController], (consumer) => {
        consumer.apply(RecordingMiddleware).exclude(target).forRoutes('*');
      });

      expect(await request('GET', '/cats')).toBe(200);
      expect(await request('GET', '/cats/1')).toBe(200);
      expect(await request('GET', '/cats/a/1/toys')).toBe(200);
      expect(await request('GET', '/dogs/1')).toBe(200);
      expect(seen).toEqual(['GET /cats', 'GET /dogs/1']);
    },
  );

  it("skips /cats itself when 'cats/{*splat}' is excluded, as Nest does", async () => {
    const request = await createApp([CatsWithIndexController, DogsController], (consumer) => {
      consumer.apply(RecordingMiddleware).exclude('cats/{*splat}').forRoutes('*');
    });

    expect(await request('GET', '/cats')).toBe(200);
    expect(await request('GET', '/cats/1')).toBe(200);
    expect(await request('GET', '/dogs/1')).toBe(200);
    expect(seen).toEqual(['GET /dogs/1']);
  });

  // A wildcard that spans segments before the last one would need
  // backtracking, so these targets fail the route build instead of matching
  // something else.
  it.each([
    'cats/*path/toys',
    'cats/(.*)/toys',
    'files/*path/:id',
    'files/(.*)/:id',
    'users/*id/admin',
    'cats/{*splat}/toys',
  ])("rejects the Nest wildcard before the last segment of '%s'", async (target) => {
    const message = `Middleware route '${target}' has a wildcard before its last segment`;
    await expect(createApp([CatsWithIndexController], forRoutes(target))).rejects.toThrow(message);
    await expect(
      createApp([CatsWithIndexController], (consumer) => {
        consumer.apply(RecordingMiddleware).exclude(target).forRoutes('*');
      }),
    ).rejects.toThrow(message);
  });

  it('reports a Nest wildcard target that only the parent route would match', async () => {
    @Controller('/cats')
    class CatsIndexOnlyController {
      @Get()
      list() {
        return { ok: true };
      }
    }

    await expect(
      createApp([CatsIndexOnlyController], forRoutes('cats/*path'), { diagnostics: 'throw' }),
    ).rejects.toThrow("[vela] Middleware route 'cats/*path' resolves to '/cats/*path'");
  });

  it('translates a Nest wildcard in an exclude() target', async () => {
    const request = await createApp([CatsController, DogsController], (consumer) => {
      consumer.apply(RecordingMiddleware).exclude('cats/*path').forRoutes('*');
    });

    expect(await request('GET', '/cats/1')).toBe(200);
    expect(await request('GET', '/dogs/1')).toBe(200);
    expect(seen).toEqual(['GET /dogs/1']);
  });

  it("rejects a constrained parameter such as 'cats/:id{[0-9]+}', naming the controller form", async () => {
    await expect(createApp([CatsController], forRoutes('cats/:id{[0-9]+}'))).rejects.toThrow(
      "Middleware route 'cats/:id{[0-9]+}' uses a '{regex}' constraint: use ':name' or " +
        'target the controller.',
    );
  });

  it('matches literal segments as text, not as regular expressions', async () => {
    @Controller()
    class VersionedController {
      @Get('v1.0/items')
      dotted() {
        return { ok: true };
      }

      @Get('v1x0/items')
      lookalike() {
        return { ok: true };
      }

      @Get('a+b')
      plus() {
        return { ok: true };
      }

      @Get('aab')
      repeated() {
        return { ok: true };
      }
    }

    const request = await createApp([VersionedController], forRoutes('v1.0', 'a+b'), {
      diagnostics: 'throw',
    });

    expect(await request('GET', '/v1.0/items')).toBe(200);
    expect(await request('GET', '/v1x0/items')).toBe(200);
    expect(await request('GET', '/a+b')).toBe(200);
    expect(await request('GET', '/aab')).toBe(200);
    expect(seen).toEqual(['GET /v1.0/items', 'GET /a+b']);

    seen = [];
    const excluded = await createApp([VersionedController], (consumer) => {
      consumer.apply(RecordingMiddleware).exclude('v1.0/items').forRoutes('*');
    });
    expect(await excluded('GET', '/v1.0/items')).toBe(200);
    expect(await excluded('GET', '/v1x0/items')).toBe(200);
    expect(seen).toEqual(['GET /v1x0/items']);
  });

  it('reports a wildcard target that needs more segments than any route has', async () => {
    @Controller('/files')
    class ShallowFilesController {
      @Get(':a')
      one() {
        return { ok: true };
      }
    }

    // A Nest wildcard may only end the target now, so it sits after ':a'.
    await expect(
      createApp([ShallowFilesController], forRoutes('files/:a/*path'), { diagnostics: 'throw' }),
    ).rejects.toThrow("[vela] Middleware route 'files/:a/*path' resolves to");
  });

  it('accepts a parameter target for a regex-constrained route', async () => {
    @Controller('/users')
    class SlugController {
      @Get(':slug{[a-z]+}')
      one() {
        return { ok: true };
      }
    }

    const request = await createApp([SlugController], forRoutes('users/:slug'), {
      diagnostics: 'throw',
    });
    expect(await request('GET', '/users/abc')).toBe(200);
    expect(seen).toEqual(['GET /users/abc']);
  });
});

// Hono decodes %0A, %0D, %E2%80%A8 and %E2%80%A9 into c.req.path, and a
// ':id' segment accepts them, so ':name' segments and wildcards match them too
// or the route is served without its middleware.
describe('targets match decoded line terminators', () => {
  @Controller('admin')
  class AdminUsersController {
    @Delete('users/:id')
    remove() {
      return { ok: true };
    }
  }

  const TERMINATORS = ['%0A', '%0D', '%E2%80%A8', '%E2%80%A9'];

  it.each(
    [
      'admin',
      'admin/*',
      'admin/*path',
      'admin/{*path}',
      'admin/(.*)',
      'admin/users/:id',
      'admin/:section',
    ].flatMap((target) => TERMINATORS.map((encoded) => [target, encoded])),
  )("runs forRoutes('%s') middleware for a path that decodes %s", async (target, encoded) => {
    const request = await createApp([AdminUsersController], forRoutes(target), {
      globalPrefix: '/api',
      diagnostics: 'throw',
    });

    expect(await request('DELETE', `/api/admin/users/7${encoded}`)).toBe(200);
    expect(seen).toEqual([`DELETE /api/admin/users/7${decodeURI(encoded)}`]);
  });

  it.each(
    ['admin/users/:id', 'admin/*path', 'admin/*'].flatMap((target) =>
      TERMINATORS.map((encoded) => [target, encoded]),
    ),
  )("skips exclude('%s') for a path that decodes %s", async (target, encoded) => {
    const request = await createApp([AdminUsersController], (consumer) => {
      consumer.apply(RecordingMiddleware).exclude(target).forRoutes('*');
    });

    expect(await request('DELETE', `/admin/users/${encoded}7`)).toBe(200);
    expect(await request('DELETE', '/admin')).toBe(404);
    expect(seen).toEqual(target === 'admin/*' ? [] : ['DELETE /admin']);
  });

  it.each(['%0A', '%0D', '%E2%80%A8', '%E2%80%A9'])(
    'runs forRoutes(Controller) middleware for a path that decodes %s',
    async (encoded) => {
      const request = await createApp([AdminUsersController], forRoutes(AdminUsersController), {
        globalPrefix: '/api',
      });

      expect(await request('DELETE', `/api/admin/users/7${encoded}`)).toBe(200);
      expect(seen).toEqual([`DELETE /api/admin/users/7${decodeURI(encoded)}`]);
    },
  );
});

describe('request methods match method-scoped targets as Hono routes them', () => {
  @Controller('/hooks')
  class HooksController {
    @All()
    any() {
      return { ok: true };
    }
  }

  it("keeps running middleware for the method token 'ALL' when a GET target is excluded", async () => {
    const request = await createApp([HooksController], (consumer) => {
      consumer
        .apply(RecordingMiddleware)
        .exclude({ path: 'hooks', method: HttpMethod.GET })
        .forRoutes('*');
    });

    expect(await request('ALL', '/hooks')).toBe(200);
    expect(await request('GET', '/hooks')).toBe(200);
    expect(await request('HEAD', '/hooks')).toBe(200);
    expect(seen).toEqual(['ALL /hooks']);
  });

  it("matches a GET target only for GET and HEAD requests, not the method token 'ALL'", async () => {
    const request = await createApp(
      [HooksController],
      forRoutes({ path: 'hooks', method: HttpMethod.GET }),
    );

    expect(await request('ALL', '/hooks')).toBe(200);
    expect(await request('POST', '/hooks')).toBe(200);
    expect(await request('GET', '/hooks')).toBe(200);
    expect(await request('HEAD', '/hooks')).toBe(200);
    expect(seen).toEqual(['GET /hooks', 'HEAD /hooks']);
  });
});

// forRoutes(Controller) asks Hono which handler serves the request, so the
// middleware runs exactly when one of the controller's own handlers does.
describe('forRoutes(Controller) follows the handler Hono dispatches to', () => {
  it('runs for a dynamic route whose literal segment continues into a parameter', async () => {
    @Controller('/files')
    class FilesController {
      @Get(':dir/abc:name')
      one() {
        return { ok: true };
      }
    }

    const request = await createApp([FilesController], forRoutes(FilesController));

    expect(await request('GET', '/files/d/abcX')).toBe(200);
    expect(seen).toEqual(['GET /files/d/abcX']);
  });

  it('skips a request that an earlier controller serves on the same path', async () => {
    @Controller('/shared')
    class ProfileController {
      @Get('me')
      me() {
        return { ok: true };
      }
    }

    @Controller('/shared')
    class ItemsController {
      @Get(':id')
      one() {
        return { ok: true };
      }
    }

    const request = await createApp(
      [ProfileController, ItemsController],
      forRoutes(ItemsController),
    );

    expect(await request('GET', '/shared/me')).toBe(200);
    expect(await request('GET', '/shared/7')).toBe(200);
    expect(await request('GET', '/shared/7/extra')).toBe(404);
    expect(seen).toEqual(['GET /shared/7']);
  });

  it('runs for a controller route in an app mounted by two nested parents', async () => {
    @Controller('/admin')
    class AdminController {
      @Get(':id')
      one() {
        return { ok: true };
      }
    }

    @Module({ providers: [RecordingMiddleware], controllers: [AdminController] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(RecordingMiddleware).forRoutes(AdminController);
      }
    }
    const app = await VelaFactory.create(AppModule);
    const inner = new Hono().route('/inner', app.getHonoApp());
    inner.onError((error, c) => c.text(String(error), 500));
    const outer = new Hono().route('/outer', inner);

    expect((await outer.request('/outer/inner/admin/7')).status).toBe(200);
    expect(seen).toEqual(['GET /outer/inner/admin/7']);
  });
});
