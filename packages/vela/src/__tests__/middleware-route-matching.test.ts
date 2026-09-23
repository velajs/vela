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

  it('keeps a relative target under the global prefix and reports that it matches no route', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = await createPlatformApp((consumer) => {
      consumer.apply(RecordingMiddleware).forRoutes('/rpc');
    });

    expect(await request('POST', '/rpc')).toBe(200);
    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[vela] Middleware route '/rpc' resolves to '/api/rpc', which matches no route " +
        'registered at startup, so the middleware never runs for it. If the route is served ' +
        'outside the global prefix or added to the Hono app after startup (mountOpenApi(), ' +
        "WebSocket upgrades, app.getHonoApp()), pass { path: '/rpc', absolute: true }.",
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

  it.each(['cats/*path/toys', 'cats/(.*)/toys'])(
    "matches one or more segments for the mid-path wildcard in '%s'",
    async (target) => {
      const request = await createApp([CatsWithIndexController, CatsController], forRoutes(target));

      expect(await request('GET', '/cats/1')).toBe(200);
      expect(await request('GET', '/cats/1/toys')).toBe(200);
      expect(await request('GET', '/cats/a/1/toys')).toBe(200);
      expect(seen).toEqual(['GET /cats/1/toys', 'GET /cats/a/1/toys']);

      seen = [];
      const excluded = await createApp([CatsWithIndexController, CatsController], (consumer) => {
        consumer.apply(RecordingMiddleware).exclude(target).forRoutes('*');
      });
      expect(await excluded('GET', '/cats/1')).toBe(200);
      expect(await excluded('GET', '/cats/a/1/toys')).toBe(200);
      expect(seen).toEqual(['GET /cats/1']);
    },
  );

  it('rejects an optional wildcard before the last segment', async () => {
    await expect(
      createApp([CatsWithIndexController], forRoutes('cats/{*splat}/toys')),
    ).rejects.toThrow("Middleware route 'cats/{*splat}/toys' uses pattern syntax");
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
    ).rejects.toThrow("[vela] Middleware route 'cats/*path' resolves to '/cats/:path{.+}'");
  });

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

  @Controller('/files')
  class FilesController {
    @Get(':a')
    one() {
      return { ok: true };
    }

    @Get(':a/:b')
    two() {
      return { ok: true };
    }

    @Get(':a/:b/:c')
    three() {
      return { ok: true };
    }
  }

  it.each(['files/*path/:id', 'files/(.*)/:id'])(
    "matches a parameter after the mid-path wildcard in '%s'",
    async (target) => {
      const request = await createApp([FilesController], forRoutes(target), {
        diagnostics: 'throw',
      });

      expect(await request('GET', '/files/x')).toBe(200);
      expect(await request('GET', '/files/x/y')).toBe(200);
      expect(await request('GET', '/files/x/y/z')).toBe(200);
      expect(seen).toEqual(['GET /files/x/y', 'GET /files/x/y/z']);

      seen = [];
      const excluded = await createApp([FilesController], (consumer) => {
        consumer.apply(RecordingMiddleware).exclude(target).forRoutes('*');
      });
      expect(await excluded('GET', '/files/x')).toBe(200);
      expect(await excluded('GET', '/files/x/y')).toBe(200);
      expect(await excluded('GET', '/files/x/y/z')).toBe(200);
      expect(seen).toEqual(['GET /files/x']);
    },
  );

  it("backtracks a mid-path wildcard onto the literal after it in 'users/*id/admin'", async () => {
    @Controller('/users')
    class UsersAdminController {
      @Get(':id/admin/administrators')
      administrators() {
        return { ok: true };
      }

      @Get(':id/admin/:scope/administrators')
      scoped() {
        return { ok: true };
      }

      @Get(':id/administrators')
      direct() {
        return { ok: true };
      }

      @Get(':id/adminx')
      lookalike() {
        return { ok: true };
      }
    }

    const request = await createApp([UsersAdminController], forRoutes('users/*id/admin'), {
      diagnostics: 'throw',
    });

    expect(await request('GET', '/users/1/admin/administrators')).toBe(200);
    expect(await request('GET', '/users/1/admin/x/administrators')).toBe(200);
    expect(await request('GET', '/users/1/administrators')).toBe(200);
    expect(await request('GET', '/users/1/adminx')).toBe(200);
    expect(seen).toEqual([
      'GET /users/1/admin/administrators',
      'GET /users/1/admin/x/administrators',
    ]);
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

    await expect(
      createApp([ShallowFilesController], forRoutes('files/*path/:id'), { diagnostics: 'throw' }),
    ).rejects.toThrow("[vela] Middleware route 'files/*path/:id' resolves to");
  });

  it('reports a constrained target that no constrained route value satisfies', async () => {
    @Controller('/users')
    class SlugController {
      @Get(':slug{[a-z]+}')
      one() {
        return { ok: true };
      }
    }

    await expect(
      createApp([SlugController], forRoutes('users/:id{[0-9]+}'), { diagnostics: 'throw' }),
    ).rejects.toThrow("[vela] Middleware route 'users/:id{[0-9]+}' resolves to");
  });
});
