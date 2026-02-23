import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Controller,
  Version,
  Get,
  Post,
  Param,
  Query,
  Injectable,
  Module,
  MetadataRegistry,
  createParamDecorator,
  ParseIntPipe,
} from '../index.js';
import type { ExecutionContext } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

// =============================================================================
// Versioned routes
// =============================================================================

describe('Versioned routes', () => {
  it('should register routes with version prefix from controller', async () => {
    @Controller({ prefix: '/users', version: 1 })
    class UserV1Controller {
      @Get()
      list() {
        return { version: 1, users: ['alice'] };
      }

      @Get('/:id')
      findOne(@Param('id') id: string) {
        return { version: 1, id };
      }
    }

    @Module({ controllers: [UserV1Controller] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/v1/users');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1, users: ['alice'] });

    const res2 = await hono.request('/v1/users/42');
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ version: 1, id: '42' });

    // Without version — 404
    const res3 = await hono.request('/users');
    expect(res3.status).toBe(404);
  });

  it('should register routes at multiple versions via version array', async () => {
    @Controller({ prefix: '/items', version: [1, 2] })
    class ItemController {
      @Get()
      list() {
        return { items: ['a', 'b'] };
      }
    }

    @Module({ controllers: [ItemController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res1 = await hono.request('/v1/items');
    expect(res1.status).toBe(200);

    const res2 = await hono.request('/v2/items');
    expect(res2.status).toBe(200);

    // Without version — 404
    const res3 = await hono.request('/items');
    expect(res3.status).toBe(404);
  });

  it('should allow @Version() on a method to override controller version', async () => {
    @Controller({ prefix: '/docs', version: 1 })
    class DocController {
      @Get()
      listV1() {
        return { version: 1 };
      }

      @Version(2)
      @Get('/new')
      listV2() {
        return { version: 2 };
      }
    }

    @Module({ controllers: [DocController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Default version 1
    const res1 = await hono.request('/v1/docs');
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ version: 1 });

    // Method-level version 2
    const res2 = await hono.request('/v2/docs/new');
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ version: 2 });

    // V1 for /new should 404 (method is V2 only)
    const res3 = await hono.request('/v1/docs/new');
    expect(res3.status).toBe(404);
  });

  it('should work without version (no prefix added)', async () => {
    @Controller('/plain')
    class PlainController {
      @Get()
      handle() {
        return { plain: true };
      }
    }

    @Module({ controllers: [PlainController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/plain');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plain: true });
  });
});

// =============================================================================
// Global prefix
// =============================================================================

describe('Global prefix', () => {
  it('should prepend global prefix to all routes', async () => {
    @Controller('/users')
    class UserController {
      @Get()
      list() {
        return ['alice'];
      }
    }

    @Controller('/posts')
    class PostController {
      @Get()
      list() {
        return ['hello'];
      }
    }

    @Module({ controllers: [UserController, PostController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.setGlobalPrefix('/api');
    await app.rebuild();
    const hono = app.getHonoApp();

    const res1 = await hono.request('/api/users');
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual(['alice']);

    const res2 = await hono.request('/api/posts');
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual(['hello']);

    // Without prefix — 404
    const res3 = await hono.request('/users');
    expect(res3.status).toBe(404);
  });

  it('should combine global prefix with versioned routes', async () => {
    @Controller({ prefix: '/users', version: 1 })
    class UserController {
      @Get()
      list() {
        return { ok: true };
      }
    }

    @Module({ controllers: [UserController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.setGlobalPrefix('/api');
    await app.rebuild();
    const hono = app.getHonoApp();

    // Global prefix + version + controller prefix
    const res = await hono.request('/api/v1/users');
    expect(res.status).toBe(200);

    // Missing global prefix — 404
    const res2 = await hono.request('/v1/users');
    expect(res2.status).toBe(404);
  });
});

// =============================================================================
// Custom param decorator factory
// =============================================================================

describe('createParamDecorator', () => {
  it('should create a custom parameter decorator', async () => {
    const CurrentUser = createParamDecorator(
      (_data: unknown, ctx: ExecutionContext) => {
        const req = ctx.getRequest();
        return req.headers.get('x-user-id') ?? 'anonymous';
      },
    );

    @Controller('/profile')
    class ProfileController {
      @Get()
      getProfile(@CurrentUser() userId: string) {
        return { userId };
      }
    }

    @Module({ controllers: [ProfileController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res1 = await hono.request('/profile');
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ userId: 'anonymous' });

    const res2 = await hono.request('/profile', {
      headers: { 'x-user-id': 'user-123' },
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ userId: 'user-123' });
  });

  it('should pass data argument to the factory', async () => {
    const Header = createParamDecorator<string>(
      (headerName: string, ctx: ExecutionContext) => {
        return ctx.getRequest().headers.get(headerName);
      },
    );

    @Controller('/headers')
    class HeaderController {
      @Get()
      handle(
        @Header('x-request-id') requestId: string,
        @Header('x-trace-id') traceId: string,
      ) {
        return { requestId, traceId };
      }
    }

    @Module({ controllers: [HeaderController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/headers', {
      headers: {
        'x-request-id': 'req-abc',
        'x-trace-id': 'trace-xyz',
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      requestId: 'req-abc',
      traceId: 'trace-xyz',
    });
  });

  it('should support pipes with custom param decorators', async () => {
    const ParamInt = createParamDecorator<string>(
      (paramName: string, ctx: ExecutionContext) => {
        const honoCtx = ctx.getContext<import('hono').Context>();
        return honoCtx.req.param(paramName);
      },
    );

    @Controller('/typed')
    class TypedController {
      @Get('/:id')
      handle(@ParamInt('id', ParseIntPipe) id: number) {
        return { id, type: typeof id };
      }
    }

    @Module({ controllers: [TypedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/typed/42');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 42, type: 'number' });

    const res2 = await hono.request('/typed/abc');
    expect(res2.status).toBe(400);
  });

  it('should provide ExecutionContext with correct class and handler info', async () => {
    let capturedCtx: ExecutionContext | null = null;

    const CaptureContext = createParamDecorator(
      (_data: unknown, ctx: ExecutionContext) => {
        capturedCtx = ctx;
        return 'captured';
      },
    );

    @Controller('/ctx-test')
    class CtxTestController {
      @Get()
      handle(@CaptureContext() _value: string) {
        return { ok: true };
      }
    }

    @Module({ controllers: [CtxTestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/ctx-test');

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.getClass()).toBe(CtxTestController);
    expect(capturedCtx!.getHandler()).toBe('handle');
    expect(capturedCtx!.getRequest()).toBeInstanceOf(Request);
  });
});
