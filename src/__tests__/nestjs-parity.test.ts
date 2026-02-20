import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  VelaFactory,
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Module,
  Injectable,
  HttpCode,
  Header,
  Redirect,
  MetadataRegistry,
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
} from '../index.js';
import type {
  CanActivate,
  ExecutionContext,
  NestInterceptor,
  CallHandler,
  PipeTransform,
  ArgumentMetadata,
  ExceptionFilter,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

// =============================================================================
// @HttpCode
// =============================================================================

describe('@HttpCode', () => {
  it('should override the default 200 status code', async () => {
    @Controller('/items')
    class ItemController {
      @Post()
      @HttpCode(201)
      create(@Body() data: { name: string }) {
        return { id: 1, ...data };
      }
    }

    @Module({ controllers: [ItemController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Widget' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 1, name: 'Widget' });
  });

  it('should return custom status for null responses', async () => {
    @Controller('/actions')
    class ActionController {
      @Post('/accept')
      @HttpCode(202)
      accept() {
        return null;
      }
    }

    @Module({ controllers: [ActionController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/actions/accept', { method: 'POST' });
    expect(res.status).toBe(202);
  });

  it('should work with @Delete returning 204 No Content', async () => {
    @Controller('/resources')
    class ResourceController {
      @Delete('/:id')
      @HttpCode(204)
      remove(@Param('id') _id: string) {
        return null;
      }
    }

    @Module({ controllers: [ResourceController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/resources/1', { method: 'DELETE' });
    expect(res.status).toBe(204);
  });
});

// =============================================================================
// @Header
// =============================================================================

describe('@Header', () => {
  it('should set a single response header', async () => {
    @Controller('/cached')
    class CachedController {
      @Get()
      @Header('Cache-Control', 'max-age=3600')
      getData() {
        return { data: 'cached' };
      }
    }

    @Module({ controllers: [CachedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/cached');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('max-age=3600');
    expect(await res.json()).toEqual({ data: 'cached' });
  });

  it('should set multiple response headers', async () => {
    @Controller('/multi-header')
    class MultiHeaderController {
      @Get()
      @Header('X-Request-Id', 'abc-123')
      @Header('X-Powered-By', 'vela')
      @Header('Cache-Control', 'no-store')
      getData() {
        return { ok: true };
      }
    }

    @Module({ controllers: [MultiHeaderController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/multi-header');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Request-Id')).toBe('abc-123');
    expect(res.headers.get('X-Powered-By')).toBe('vela');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('should combine @Header with @HttpCode', async () => {
    @Controller('/combo')
    class ComboController {
      @Post()
      @HttpCode(201)
      @Header('Location', '/combo/1')
      create() {
        return { id: 1 };
      }
    }

    @Module({ controllers: [ComboController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/combo', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(res.headers.get('Location')).toBe('/combo/1');
  });
});

// =============================================================================
// @Redirect
// =============================================================================

describe('@Redirect', () => {
  it('should redirect to a static URL', async () => {
    @Controller('/old')
    class OldController {
      @Get()
      @Redirect('/new', 301)
      handle() {}
    }

    @Module({ controllers: [OldController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/old', { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/new');
  });

  it('should default to 302 when no status provided', async () => {
    @Controller('/temp')
    class TempController {
      @Get()
      @Redirect('/target')
      handle() {}
    }

    @Module({ controllers: [TempController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/temp', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/target');
  });

  it('should allow dynamic redirect via return value', async () => {
    @Controller('/dynamic')
    class DynamicController {
      @Get()
      @Redirect('/default')
      handle(@Query('to') to?: string) {
        if (to) return { url: to };
      }
    }

    @Module({ controllers: [DynamicController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Without override — default
    const res1 = await hono.request('/dynamic', { redirect: 'manual' });
    expect(res1.headers.get('Location')).toBe('/default');

    // With override
    const res2 = await hono.request('/dynamic?to=/custom', { redirect: 'manual' });
    expect(res2.headers.get('Location')).toBe('/custom');
  });

  it('should allow overriding status code via return value', async () => {
    @Controller('/status-override')
    class StatusOverrideController {
      @Get()
      @Redirect('/default', 302)
      handle(@Query('permanent') permanent?: string) {
        if (permanent) return { url: '/permanent-target', statusCode: 301 };
      }
    }

    @Module({ controllers: [StatusOverrideController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res1 = await hono.request('/status-override', { redirect: 'manual' });
    expect(res1.status).toBe(302);

    const res2 = await hono.request('/status-override?permanent=true', { redirect: 'manual' });
    expect(res2.status).toBe(301);
    expect(res2.headers.get('Location')).toBe('/permanent-target');
  });
});

// =============================================================================
// APP_* tokens
// =============================================================================

describe('APP_* tokens', () => {
  it('should register global guard via APP_GUARD provider', async () => {
    @Injectable()
    class ApiKeyGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.getRequest();
        return req.headers.get('x-api-key') === 'secret';
      }
    }

    @Controller('/guarded')
    class GuardedController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [
        ApiKeyGuard,
        { token: APP_GUARD, useExisting: ApiKeyGuard },
      ],
      controllers: [GuardedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res1 = await hono.request('/guarded');
    expect(res1.status).toBe(403);

    const res2 = await hono.request('/guarded', {
      headers: { 'x-api-key': 'secret' },
    });
    expect(res2.status).toBe(200);
  });

  it('should register global interceptor via APP_INTERCEPTOR provider', async () => {
    @Injectable()
    class WrapInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        const result = await next.handle();
        return { data: result, wrapped: true };
      }
    }

    @Controller('/intercepted')
    class InterceptedController {
      @Get()
      handle() {
        return 'hello';
      }
    }

    @Module({
      providers: [
        WrapInterceptor,
        { token: APP_INTERCEPTOR, useExisting: WrapInterceptor },
      ],
      controllers: [InterceptedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/intercepted');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'hello', wrapped: true });
  });

  it('should register global pipe via APP_PIPE provider', async () => {
    @Injectable()
    class TrimPipe implements PipeTransform<unknown> {
      transform(value: unknown, _metadata: ArgumentMetadata) {
        if (typeof value === 'string') return value.trim();
        return value;
      }
    }

    @Controller('/trimmed')
    class TrimmedController {
      @Get('/:name')
      handle(@Param('name') name: string) {
        return { name };
      }
    }

    @Module({
      providers: [
        TrimPipe,
        { token: APP_PIPE, useExisting: TrimPipe },
      ],
      controllers: [TrimmedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Route params don't have leading/trailing spaces, but the pipe still runs
    const res = await hono.request('/trimmed/hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'hello' });
  });
});
