import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context, type Next } from 'hono';
import {
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
) {
  @Module({ providers: [RecordingMiddleware], controllers })
  class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      configure(consumer);
    }
  }
  const app = await VelaFactory.create(AppModule, options);
  const hono =
    mountAt === undefined ? app.getHonoApp() : new Hono().route(mountAt, app.getHonoApp());
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

describe('forRoutes(string | RouteInfo) uses Hono route patterns', () => {
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

  it('keeps a relative target under the global prefix', async () => {
    const request = await createPlatformApp((consumer) => {
      consumer.apply(RecordingMiddleware).forRoutes('/rpc');
    });

    expect(await request('POST', '/rpc')).toBe(200);
    expect(seen).toEqual([]);
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

  it.each(['cats/*path', 'cats/{*splat}', 'cats/(.*)', 'cats/*'])(
    "translates '%s' to a trailing Hono wildcard",
    async (target) => {
      const request = await createApp([CatsController, DogsController], forRoutes(target), {
        globalPrefix: '/api',
      });

      expect(await request('GET', '/api/cats/1')).toBe(200);
      expect(await request('GET', '/api/cats/1/toys')).toBe(200);
      expect(await request('GET', '/api/dogs/1')).toBe(200);
      expect(seen).toEqual(['GET /api/cats/1', 'GET /api/cats/1/toys']);
    },
  );

  it('translates a Nest wildcard in an exclude() target', async () => {
    const request = await createApp([CatsController, DogsController], (consumer) => {
      consumer.apply(RecordingMiddleware).exclude('cats/*path').forRoutes('*');
    });

    expect(await request('GET', '/cats/1')).toBe(200);
    expect(await request('GET', '/dogs/1')).toBe(200);
    expect(seen).toEqual(['GET /dogs/1']);
  });

  it('keeps Hono regex-constrained parameters', async () => {
    const request = await createApp([CatsController], forRoutes('cats/:id{[0-9]+}'));

    expect(await request('GET', '/cats/42')).toBe(200);
    expect(await request('GET', '/cats/tom')).toBe(200);
    expect(seen).toEqual(['GET /cats/42']);
  });

  it.each(['cats/:id(\\d+)', 'cats/ab*cd', 'cats{/:id}', 'cats/(a|b)'])(
    "rejects '%s', which no Hono pattern matches",
    async (target) => {
      await expect(createApp([CatsController], forRoutes(target))).rejects.toThrow(
        `Middleware route '${target}' uses pattern syntax that Hono does not match`,
      );
    },
  );
});
