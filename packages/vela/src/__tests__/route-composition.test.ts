import { describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Module,
  Post,
  Sse,
  VERSION_NEUTRAL,
  Version,
  VelaFactory,
  type MessageEvent,
} from '../index.js';
import { createOpenApiDocument } from '../openapi/index';

@Controller('/health')
class HealthController {
  @Get()
  check() {
    return { ok: true };
  }
}

@Controller('/cats')
class CatsController {
  @Get()
  list() {
    return ['tom'];
  }

  @Post()
  create() {
    return { created: true };
  }
}

@Module({ controllers: [HealthController, CatsController] })
class PrefixModule {}

describe('setGlobalPrefix({ exclude })', () => {
  it('serves excluded routes outside the global prefix', async () => {
    const app = await VelaFactory.create(PrefixModule, {
      globalPrefix: '/api',
      globalPrefixOptions: { exclude: ['health', { path: 'cats', method: 'POST' }] },
    });
    const hono = app.getHonoApp();
    expect((await hono.request('/health')).status).toBe(200);
    expect((await hono.request('/api/health')).status).toBe(404);
    expect((await hono.request('/api/cats')).status).toBe(200);
    expect((await hono.request('/cats', { method: 'POST' })).status).toBe(200);
    expect((await hono.request('/api/cats', { method: 'POST' })).status).toBe(404);
    expect(app.describeRoutes().map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /health',
      'GET /api/cats',
      'POST /cats',
    ]);

    const document = createOpenApiDocument(PrefixModule, app.getRoutePathOptions());
    expect(Object.keys(document.paths).toSorted()).toEqual(['/api/cats', '/cats', '/health']);
  });

  it('rejects exclusions that use unsupported pattern syntax', async () => {
    await expect(
      VelaFactory.create(PrefixModule, {
        globalPrefix: '/api',
        globalPrefixOptions: { exclude: ['cats/:id{\\d+}'] },
      }),
    ).rejects.toThrow("uses a '{regex}' constraint");
  });
});

@Controller({ path: '/users', version: 1 })
class UsersController {
  @Get()
  list() {
    return 'v1';
  }

  @Get('/me')
  @Version(VERSION_NEUTRAL)
  me() {
    return 'neutral';
  }

  @Get('/both')
  @Version([2, VERSION_NEUTRAL])
  both() {
    return 'both';
  }
}

@Controller({ path: '/status', version: VERSION_NEUTRAL })
class StatusController {
  @Get()
  status() {
    return 'up';
  }
}

@Module({ controllers: [UsersController, StatusController] })
class VersionModule {}

describe('URI versioning', () => {
  it('serves VERSION_NEUTRAL routes without a version segment', async () => {
    const app = await VelaFactory.create(VersionModule);
    const hono = app.getHonoApp();
    expect(await (await hono.request('/v1/users')).text()).toBe('v1');
    expect(await (await hono.request('/users/me')).text()).toBe('neutral');
    expect((await hono.request('/v1/users/me')).status).toBe(404);
    expect(await (await hono.request('/v2/users/both')).text()).toBe('both');
    expect(await (await hono.request('/users/both')).text()).toBe('both');
    expect(await (await hono.request('/status')).text()).toBe('up');
  });

  it('uses a configurable version prefix', async () => {
    const app = await VelaFactory.create(VersionModule, { versioning: { prefix: 'version-' } });
    const hono = app.getHonoApp();
    expect(await (await hono.request('/version-1/users')).text()).toBe('v1');
    expect((await hono.request('/v1/users')).status).toBe(404);

    const bare = await VelaFactory.create(VersionModule, { versioning: { prefix: false } });
    expect(await (await bare.getHonoApp().request('/1/users')).text()).toBe('v1');

    const document = createOpenApiDocument(VersionModule, app.getRoutePathOptions());
    expect(Object.keys(document.paths).toSorted()).toEqual([
      '/status',
      '/users/both',
      '/users/me',
      '/version-1/users',
      '/version-2/users/both',
    ]);
  });

  it('rejects an unsafe version prefix', async () => {
    await expect(
      VelaFactory.create(VersionModule, { versioning: { prefix: 'v/1' } }),
    ).rejects.toThrow('version prefix');
  });
});

describe('@Sse() with an async iterable', () => {
  it('streams each MessageEvent through Server-Sent Events', async () => {
    let finished = false;

    @Controller('/events')
    class EventsController {
      @Sse()
      async *stream(): AsyncIterable<MessageEvent> {
        try {
          yield { data: 'hello' };
          yield { data: { count: 2 }, id: '2', type: 'tick', retry: 1000 };
        } finally {
          finished = true;
        }
      }
    }

    @Module({ controllers: [EventsController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const response = await app.getHonoApp().request('/events');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe(
      'data: hello\n\nevent: tick\ndata: {"count":2}\nid: 2\nretry: 1000\n\n',
    );
    expect(finished).toBe(true);
  });

  it('stops the iterable when the client disconnects', async () => {
    let finished = false;
    const produced: number[] = [];

    @Controller('/ticks')
    class TicksController {
      @Sse()
      async *ticks(): AsyncIterable<MessageEvent> {
        try {
          for (let tick = 0; ; tick++) {
            produced.push(tick);
            yield { data: String(tick) };
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        } finally {
          finished = true;
        }
      }
    }

    @Module({ controllers: [TicksController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const response = await app.getHonoApp().request('/ticks');
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(true);
    const count = produced.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(produced.length).toBe(count);
  });
});
