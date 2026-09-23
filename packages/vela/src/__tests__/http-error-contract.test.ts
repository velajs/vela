import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  BadRequestException,
  Body,
  Catch,
  ConflictException,
  Controller,
  Endpoint,
  ErrorsModule,
  ForbiddenException,
  Get,
  MetadataRegistry,
  Module,
  NotFoundException,
  Post,
  VELA_MIDDLEWARE_HANDLER,
  VELA_NOT_FOUND_HANDLER,
  ValidationPipe,
  VelaError,
  VelaFactory,
  VelaMiddlewareHost,
  ZodValidationPipe,
  defineDto,
  defineEndpoint,
  defineErrorCatalog,
  toHttpErrorBody,
} from '../index';
import type { ExceptionFilter, ExceptionHandler, ExecutionContext } from '../index';

beforeEach(() => MetadataRegistry.clear());

// One application exercising every framework-originated failure source.
async function createApp(handler?: ExceptionHandler) {
  const lookup = defineEndpoint({
    input: z.object({ query: z.object({ limit: z.coerce.number().int().max(50) }) }),
    output: z.object({ limit: z.number() }),
  });
  const Entry = defineDto(z.object({ name: z.string().min(1) }), { name: 'Entry' });

  @Controller('/catalog')
  class CatalogController {
    @Get('/lookup')
    @Endpoint(lookup)
    lookup(input: z.output<typeof lookup.input>) {
      return { limit: input.query.limit };
    }

    @Post('/pipe')
    pipe(@Body(new ValidationPipe(Entry)) body: ReturnType<typeof Entry.parse>) {
      return body;
    }

    @Post('/zod')
    zod(@Body(new ZodValidationPipe(z.object({ name: z.string().min(1) }))) body: unknown) {
      return body;
    }

    @Get('/missing')
    missing() {
      throw new NotFoundException('Entry missing');
    }

    @Get('/envelope')
    envelope() {
      // An explicit object response is user-owned and ships verbatim.
      throw new ConflictException({ success: false, result: null });
    }

    @Post('/upload')
    upload() {
      return { ok: true };
    }
  }

  @Module({
    imports: handler ? [ErrorsModule.forRoot({ handler })] : [],
    controllers: [CatalogController],
  })
  class App {}

  const app = await VelaFactory.create(App, {
    security: { body: { maxBytes: 16 }, query: { maxParameters: 3 } },
    middleware: [
      async (c, next) => {
        if (c.req.path === '/catalog/blocked')
          throw new ForbiddenException('Blocked by middleware');
        await next();
      },
    ],
  });
  return { app, hono: app.getHonoApp(), CatalogController };
}

type Hono = Awaited<ReturnType<typeof createApp>>['hono'];

// Each framework-originated failure, with its status and default error object.
function failures(hono: Hono) {
  const json = (path: string, body: string) =>
    hono.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  return [
    {
      name: 'endpoint input validation',
      send: () => hono.request('/catalog/lookup?limit=500'),
      status: 400,
      error: {
        code: 'bad_request',
        message: 'Validation failed',
        details: [{ message: expect.any(String), path: ['query', 'limit'], code: 'too_big' }],
      },
    },
    {
      name: 'ValidationPipe',
      send: () => json('/catalog/pipe', '{"name":""}'),
      status: 400,
      error: {
        code: 'bad_request',
        message: 'Validation failed',
        details: [{ message: expect.any(String), path: ['name'], code: 'too_small' }],
      },
    },
    {
      name: 'ZodValidationPipe',
      send: () => json('/catalog/zod', '{"name":""}'),
      status: 400,
      error: {
        code: 'bad_request',
        message: 'Validation failed',
        details: [{ message: expect.any(String), path: ['name'], code: 'too_small' }],
      },
    },
    {
      name: 'handler exception',
      send: () => hono.request('/catalog/missing'),
      status: 404,
      error: { code: 'not_found', message: 'Entry missing' },
    },
    {
      name: 'middleware exception',
      send: () => hono.request('/catalog/blocked'),
      status: 403,
      error: { code: 'forbidden', message: 'Blocked by middleware' },
    },
    {
      name: 'body limit',
      send: () => hono.request('/catalog/upload', { method: 'POST', body: 'x'.repeat(64) }),
      status: 413,
      error: { code: 'payload_too_large', message: 'Request body exceeds the configured limit' },
    },
    {
      name: 'query limit',
      send: () => hono.request('/catalog/lookup?a=1&b=2&c=3&d=4'),
      status: 400,
      error: { code: 'bad_request', message: 'Query parameter count exceeds the configured limit' },
    },
    {
      name: 'unmatched route',
      send: () => hono.request('/nowhere'),
      status: 404,
      error: { code: 'not_found', message: 'Route not found' },
    },
  ];
}

describe('HTTP error bodies', () => {
  it('renders every framework-originated failure as { error: { code, message, details? } }', async () => {
    const { app, hono } = await createApp();
    for (const failure of failures(hono)) {
      const response = await failure.send();
      expect(response.status, failure.name).toBe(failure.status);
      expect(response.headers.get('content-type'), failure.name).toContain('application/json');
      expect(await response.json(), failure.name).toEqual({ error: failure.error });
    }
    await app.close();
  });

  it('keeps explicit object responses verbatim', async () => {
    const { app, hono } = await createApp();
    const response = await hono.request('/catalog/envelope');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, result: null });
    await app.close();
  });

  it('customizes every failure in one ExceptionHandler.render hook', async () => {
    const contexts = new Map<string, ExecutionContext>();
    const report = vi.fn();
    const handler: ExceptionHandler = {
      report,
      render(error, context) {
        const result = toHttpErrorBody(error, { context });
        if (!result) return undefined; // explicit responses stay unchanged
        const http = context as ExecutionContext;
        contexts.set(result.body.error.message, http);
        const locale = http.getRequest().headers.get('accept-language') ?? 'en';
        return {
          ...result,
          body: { error: { ...result.body.error, message: `${locale}:${result.body.error.code}` } },
        };
      },
    };
    const { app, hono, CatalogController } = await createApp(handler);
    for (const failure of failures(hono)) {
      const response = await failure.send();
      expect(response.status, failure.name).toBe(failure.status);
      expect(await response.json(), failure.name).toEqual({
        error: { ...failure.error, message: `en:${failure.error.code}` },
      });
    }

    // Handler failures expose their controller; other failures a framework host.
    expect(contexts.get('Entry missing')?.getClass()).toBe(CatalogController);
    expect(contexts.get('Entry missing')?.getHandler()).toBe('missing');
    for (const message of [
      'Blocked by middleware',
      'Request body exceeds the configured limit',
      'Query parameter count exceeds the configured limit',
    ]) {
      expect(contexts.get(message)?.getClass(), message).toBe(VelaMiddlewareHost);
      expect(contexts.get(message)?.getHandler(), message).toBe(VELA_MIDDLEWARE_HANDLER);
    }
    const unmatched = contexts.get('Route not found');
    expect(unmatched?.getClass()).toBe(VelaMiddlewareHost);
    expect(unmatched?.getHandler()).toBe(VELA_NOT_FOUND_HANDLER);
    expect(unmatched?.getType()).toBe('http');
    expect(new URL(unmatched?.getRequest().url ?? '').pathname).toBe('/nowhere');

    const translated = await hono.request('/nowhere', { headers: { 'accept-language': 'pt' } });
    expect(await translated.json()).toEqual({
      error: { code: 'not_found', message: 'pt:not_found' },
    });
    expect((await hono.request('/catalog/envelope')).status).toBe(409);

    // Application failures are reported; framework request rejections are not.
    const reported = report.mock.calls.map(([error]) => (error as Error).message);
    expect(reported).toEqual(expect.arrayContaining(['Entry missing', 'Blocked by middleware']));
    expect(reported).not.toContain('Route not found');
    expect(reported).not.toContain('Request body exceeds the configured limit');
    expect(reported).not.toContain('Query parameter count exceeds the configured limit');
    await app.close();
  });

  it('lets a render hook replace the unmatched-route response', async () => {
    const { app, hono } = await createApp({
      render: (error, context) =>
        (context as ExecutionContext).getHandler() === VELA_NOT_FOUND_HANDLER
          ? new Response('custom', { status: 404, headers: { 'x-handled': String(error) } })
          : undefined,
    });
    const response = await hono.request('/nowhere');
    expect(response.status).toBe(404);
    expect(response.headers.get('x-handled')).toContain('Route not found');
    expect(await response.text()).toBe('custom');
    await app.close();
  });

  it('keeps framework request rejections out of exception filters', async () => {
    // A catch-all filter that returns a value renders a 200 response.
    @Catch()
    class CatchAll implements ExceptionFilter {
      catch(exception: unknown) {
        return { caught: exception instanceof Error ? exception.message : 'unknown' };
      }
    }
    const { app, hono } = await createApp();
    app.useGlobalFilters(new CatchAll());
    const unmatched = await hono.request('/nowhere');
    expect(unmatched.status).toBe(404);
    expect(await unmatched.json()).toEqual({
      error: { code: 'not_found', message: 'Route not found' },
    });
    const oversized = await hono.request('/catalog/upload', {
      method: 'POST',
      body: 'x'.repeat(64),
    });
    expect(oversized.status).toBe(413);
    const crowded = await hono.request('/catalog/lookup?a=1&b=2&c=3&d=4');
    expect(crowded.status).toBe(400);
    // Failures raised by application middleware and handlers still reach filters.
    const blocked = await hono.request('/catalog/blocked');
    expect(blocked.status).toBe(200);
    expect(await blocked.json()).toEqual({ caught: 'Blocked by middleware' });
    await app.close();
  });

  it('keeps routes registered after bootstrap reachable and HEAD bodyless', async () => {
    const { app, hono } = await createApp();
    hono.get('/late', (c) => c.json({ late: true }));
    expect(await (await hono.request('/late')).json()).toEqual({ late: true });
    const head = await hono.request('/nowhere', { method: 'HEAD' });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe('');
    // A known path with an unregistered method is also an unmatched route.
    const wrongMethod = await hono.request('/catalog/missing', { method: 'DELETE' });
    expect(wrongMethod.status).toBe(404);
    expect(await wrongMethod.json()).toEqual({
      error: { code: 'not_found', message: 'Route not found' },
    });
    await app.close();
  });

  it('sends details for string exceptions from handlers and middleware', async () => {
    @Controller('/ranges')
    class RangesController {
      @Get()
      read() {
        throw new BadRequestException('Invalid range', { details: { field: 'end' } });
      }

      @Get('/limited')
      limited() {
        return { ok: true };
      }

      @Get('/authorized')
      authorized() {
        throw new HTTPException(401, {
          res: new Response('Sign in required', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer' },
          }),
        });
      }
    }
    @Module({ controllers: [RangesController] })
    class App {}
    const app = await VelaFactory.create(App, {
      middleware: [
        async (c, next) => {
          if (c.req.path === '/ranges/limited')
            throw new ForbiddenException('Plan limit reached', { details: { limit: 3 } });
          await next();
        },
      ],
    });
    const hono = app.getHonoApp();
    const invalid = await hono.request('/ranges');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: { code: 'bad_request', message: 'Invalid range', details: { field: 'end' } },
    });
    const limited = await hono.request('/ranges/limited');
    expect(limited.status).toBe(403);
    expect(await limited.json()).toEqual({
      error: { code: 'forbidden', message: 'Plan limit reached', details: { limit: 3 } },
    });
    // A Hono HTTPException below 500 keeps its own response in handlers too.
    const unauthorized = await hono.request('/ranges/authorized');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');
    expect(await unauthorized.text()).toBe('Sign in required');
    await app.close();
  });

  it('redacts application catalog codes in hooks that start from toHttpErrorBody', async () => {
    const catalog = defineErrorCatalog({
      storage_offline: { status: 503, title: 'Storage offline', internal: true },
    });
    async function request(handler?: ExceptionHandler) {
      @Controller('/storage')
      class StorageController {
        @Get()
        read() {
          throw catalog.error('storage_offline', { message: 'volume 7 unreachable' });
        }
      }
      @Module({
        imports: [ErrorsModule.forRoot({ catalogs: [catalog], ...(handler ? { handler } : {}) })],
        controllers: [StorageController],
      })
      class App {}
      const app = await VelaFactory.create(App);
      const response = await app.getHonoApp().request('/storage');
      const body = { status: response.status, json: await response.json() };
      await app.close();
      return body;
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const expected = {
        status: 503,
        json: { error: { code: 'storage_offline', message: 'Service Unavailable' } },
      };
      expect(await request()).toEqual(expected);
      expect(
        await request({ render: (error, context) => toHttpErrorBody(error, { context }) }),
      ).toEqual(expected);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('renders errors that escape wrapped boundaries through the same path', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { app, hono } = await createApp({
        render: (error) =>
          error instanceof ForbiddenException
            ? {
                body: { error: { code: 'forbidden', message: 'hook' } },
                status: 403,
                redacted: false,
              }
            : undefined,
      });
      hono.use('/raw/*', async () => {
        throw new BadRequestException('Raw middleware rejected the request');
      });
      hono.use('/hooked/*', async () => {
        throw new ForbiddenException('Raw middleware forbade the request');
      });
      const raw = await hono.request('/raw/value');
      expect(raw.status).toBe(400);
      expect(await raw.json()).toEqual({
        error: { code: 'bad_request', message: 'Raw middleware rejected the request' },
      });
      const hooked = await hono.request('/hooked/value');
      expect(await hooked.json()).toEqual({ error: { code: 'forbidden', message: 'hook' } });
      await app.close();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('toHttpErrorBody', () => {
  it('returns the default body, or undefined when the error carries its own response', () => {
    expect(
      toHttpErrorBody(new BadRequestException('Invalid entry', { details: [{ path: ['name'] }] })),
    ).toEqual({
      body: {
        error: { code: 'bad_request', message: 'Invalid entry', details: [{ path: ['name'] }] },
      },
      status: 400,
      redacted: false,
    });
    expect(
      toHttpErrorBody(new VelaError('conflict', { message: 'Stale', data: { rev: 2 } })),
    ).toEqual({
      body: { error: { code: 'conflict', message: 'Stale', details: { rev: 2 } } },
      status: 409,
      redacted: false,
    });
    expect(toHttpErrorBody(new Error('secret detail'))).toEqual({
      body: { error: { code: 'internal', message: 'Internal Server Error' } },
      status: 500,
      redacted: true,
    });
    expect(toHttpErrorBody(new HTTPException(503, { message: 'upstream detail' }))).toEqual({
      body: { error: { code: 'internal', message: 'Internal Server Error' } },
      status: 503,
      redacted: true,
    });
    expect(toHttpErrorBody(new ConflictException({ success: false }))).toBeUndefined();
    expect(toHttpErrorBody(new HTTPException(401))).toBeUndefined();
  });
});
