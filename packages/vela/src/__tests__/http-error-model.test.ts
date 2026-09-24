import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Body,
  BadRequestException,
  Catch,
  Controller,
  ErrorsModule,
  ForbiddenException,
  Get,
  HttpException,
  InternalServerErrorException,
  Module,
  NotFoundException,
  PayloadTooLargeException,
  Post,
  UseFilters,
  VelaError,
  VelaFactory,
  getErrorStatus,
  renderHttpError,
  type ExceptionFilter,
  type HttpErrorResponse,
  type Type,
} from '../index.js';

// One HTTP error model: every edge (handler, Vela middleware, the raw Hono
// onError, the JSON notFound, request limits) renders through renderHttpError.

class TeapotException extends HttpException {
  constructor() {
    super('short and stout', 418);
  }

  override toResponse(): HttpErrorResponse {
    return { status: 418, body: { brewed: false } };
  }
}

class LeakyUpstreamException extends HttpException {
  constructor() {
    super('upstream secret', 502);
  }

  override toResponse(): HttpErrorResponse {
    return { status: 502, body: { upstream: 'db password=hunter2' } };
  }
}

// Not a framework exception: any object may define toResponse().
class ForeignUpstreamError extends Error {
  toResponse(): HttpErrorResponse {
    return { status: 503, body: { upstream: 'db password=hunter2' } };
  }
}
const foreignClientFault = {
  message: 'not ours',
  toResponse: (): HttpErrorResponse => ({ status: 400, body: { injected: 'shape' } }),
};

async function appWith(controllers: Type[]) {
  @Module({ controllers })
  class AppModule {}
  return VelaFactory.create(AppModule);
}

describe('renderHttpError', () => {
  it('renders the canonical body for strings, redacting 5xx text', () => {
    expect(renderHttpError(new NotFoundException('missing thing'))).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'missing thing' } },
      redacted: false,
    });
    expect(renderHttpError(new InternalServerErrorException('db password=hunter2'))).toEqual({
      status: 500,
      body: { error: { code: 'internal', message: 'Internal Server Error' } },
      redacted: true,
    });
  });

  it('carries HttpException details on client errors only', () => {
    expect(
      renderHttpError(new BadRequestException('Invalid input', { details: { field: 'name' } })),
    ).toEqual({
      status: 400,
      body: {
        error: { code: 'bad_request', message: 'Invalid input', details: { field: 'name' } },
      },
      redacted: false,
    });
    const hidden = renderHttpError(
      new HttpException('broken', 503, { details: { host: '10.0.0.5' } }),
    );
    expect(JSON.stringify(hidden.body)).not.toContain('10.0.0.5');
  });

  it('uses an exception-owned toResponse() and redacts 5xx bodies only on the raw edge', () => {
    expect(renderHttpError(new TeapotException())).toEqual({
      status: 418,
      body: { brewed: false },
      redacted: false,
    });
    expect(renderHttpError(new LeakyUpstreamException())).toEqual({
      status: 502,
      body: { upstream: 'db password=hunter2' },
      redacted: false,
    });
    const raw = renderHttpError(new LeakyUpstreamException(), { redactServerBodies: true });
    expect(raw).toEqual({
      status: 502,
      body: { error: { code: 'bad_gateway', message: 'Bad Gateway' } },
      redacted: true,
    });
  });

  it('renders a foreign object with toResponse() as an unknown error', () => {
    const internal = {
      status: 500,
      body: { error: { code: 'internal', message: 'Internal Server Error' } },
      redacted: true,
    };
    expect(renderHttpError(new ForeignUpstreamError('upstream'))).toEqual(internal);
    expect(renderHttpError(foreignClientFault)).toEqual(internal);
    // A framework prototype without the framework constructor owns nothing either.
    const forged: unknown = Object.assign(Object.create(BadRequestException.prototype), {
      toResponse: (): HttpErrorResponse => ({ status: 502, body: { upstream: 'secret' } }),
    });
    expect(renderHttpError(forged)).toEqual(internal);
    expect(getErrorStatus(forged)).toBe(500);
  });

  it('renders an HttpException built with a status outside 400-599 as an internal error', () => {
    const internal = {
      status: 500,
      body: { error: { code: 'internal', message: 'Internal Server Error' } },
      redacted: true,
    };
    for (const status of [101, 200, 204, 302, 600]) {
      // As in Nest, construction accepts any status and getStatus() returns it.
      const moved = new HttpException('moved', status);
      expect(moved.getStatus()).toBe(status);
      expect(renderHttpError(moved)).toEqual(internal);
      expect(renderHttpError(new HttpException({ ok: true }, status))).toEqual(internal);
      expect(getErrorStatus(moved)).toBe(500);
    }
  });

  it('renders object HttpException responses through the default toResponse()', () => {
    expect(new BadRequestException({ custom: 'shape' }).toResponse()).toEqual({
      status: 400,
      body: { custom: 'shape' },
    });
    expect(new NotFoundException('text').toResponse()).toBeUndefined();
  });

  it('renders VelaError and unknown errors through the catalog', () => {
    expect(
      renderHttpError(new VelaError('conflict', { message: 'rev', data: { rev: 3 } })),
    ).toEqual({
      status: 409,
      body: { error: { code: 'conflict', message: 'rev', details: { rev: 3 } } },
      redacted: false,
    });
    expect(renderHttpError(new Error('secret'))).toEqual({
      status: 500,
      body: { error: { code: 'internal', message: 'Internal Server Error' } },
      redacted: true,
    });
  });

  it('ignores an invalid or throwing toResponse()', () => {
    const invalid = Object.assign(new ForbiddenException('nope'), {
      toResponse: () => ({ status: 200, body: { ok: true } }),
    });
    expect(renderHttpError(invalid).status).toBe(403);
    const throwing = Object.assign(new ForbiddenException('nope'), {
      toResponse: () => {
        throw new Error('broken');
      },
    });
    expect(renderHttpError(throwing)).toEqual({
      status: 403,
      body: { error: { code: 'forbidden', message: 'nope' } },
      redacted: false,
    });
  });

  it('no longer exposes getRawResponse()', () => {
    expect('getRawResponse' in HttpException.prototype).toBe(false);
  });
});

describe('getErrorStatus', () => {
  it('reads HttpException, VelaError, and defaults to 500', () => {
    expect(getErrorStatus(new NotFoundException())).toBe(404);
    expect(getErrorStatus(new VelaError('conflict'))).toBe(409);
    expect(getErrorStatus(new Error('x'))).toBe(500);
    expect(getErrorStatus('thrown string')).toBe(500);
  });
});

describe('HTTP edges share one renderer', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('answers unmatched routes with a JSON 404 without reporting', async () => {
    @Controller('/known')
    class KnownController {
      @Get()
      handle() {
        return { ok: true };
      }
    }
    const app = await appWith([KnownController]);
    const response = await app.getHonoApp().request('/missing');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not Found' } });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('lets the application render hook customize the 404', async () => {
    @Controller('/known')
    class KnownController {
      @Get()
      handle() {
        return { ok: true };
      }
    }
    @Module({
      controllers: [KnownController],
      imports: [
        ErrorsModule.forRoot({
          handler: {
            render: (error) =>
              error instanceof NotFoundException
                ? {
                    body: { error: { code: 'nope', message: 'Nothing here' } },
                    status: 404,
                    redacted: false,
                  }
                : undefined,
          },
        }),
      ],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule);
    const response = await app.getHonoApp().request('/missing');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'nope', message: 'Nothing here' } });
  });

  it('renders a Hono HTTPException as JSON unless it carries its own Response', async () => {
    @Controller('/hono')
    class HonoController {
      @Get('/message')
      message() {
        throw new HTTPException(403, { message: 'nope' });
      }

      @Get('/challenge')
      challenge() {
        throw new HTTPException(401, {
          res: new Response('sign in', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer realm="api"' },
          }),
        });
      }
    }
    const app = await appWith([HonoController]);
    const message = await app.getHonoApp().request('/hono/message');
    expect(message.status).toBe(403);
    expect(message.headers.get('content-type')).toContain('application/json');
    expect(await message.json()).toEqual({ error: { code: 'forbidden', message: 'nope' } });

    // An auth challenge keeps its own Response and headers.
    const challenge = await app.getHonoApp().request('/hono/challenge');
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toBe('Bearer realm="api"');
    expect(await challenge.text()).toBe('sign in');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('renders oversized bodies as a JSON 413', async () => {
    @Controller('/upload')
    class UploadController {
      @Post()
      handle() {
        return { ok: true };
      }
    }
    @Module({ controllers: [UploadController] })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { security: { body: { maxBytes: 8 } } });
    const response = await app.getHonoApp().request('/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'far more than eight bytes' }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: 'payload_too_large', message: 'Payload Too Large' },
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('uses toResponse() from handlers and Vela middleware, redacting 5xx only on raw Hono', async () => {
    @Controller('/owned')
    class OwnedController {
      @Get('/teapot')
      teapot() {
        throw new TeapotException();
      }

      @Get('/upstream')
      upstream() {
        throw new LeakyUpstreamException();
      }
    }
    const app = await appWith([OwnedController]);
    const hono = app.getHonoApp();
    // Raw Hono middleware bypasses Vela's wrapping; only onError sees its throw.
    hono.use('/raw/*', async (_c: Context, _next: Next) => {
      throw new LeakyUpstreamException();
    });
    const teapot = await hono.request('/owned/teapot');
    expect(teapot.status).toBe(418);
    expect(await teapot.json()).toEqual({ brewed: false });
    const upstream = await hono.request('/owned/upstream');
    expect(upstream.status).toBe(502);
    expect(await upstream.json()).toEqual({ upstream: 'db password=hunter2' });

    const raw = await hono.request('/raw/boom');
    expect(raw.status).toBe(502);
    expect(await raw.json()).toEqual({ error: { code: 'bad_gateway', message: 'Bad Gateway' } });
  });

  it('reports and redacts a foreign toResponse() object on handler and middleware edges', async () => {
    @Controller('/foreign')
    class ForeignController {
      @Get('/server')
      server() {
        throw new ForeignUpstreamError('upstream');
      }

      @Get('/client')
      client() {
        throw foreignClientFault;
      }
    }
    @Module({ controllers: [ForeignController] })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, {
      middleware: [
        async (c: Context, next: Next) => {
          if (c.req.path === '/foreign/middleware') throw new ForeignUpstreamError('upstream');
          await next();
        },
      ],
    });
    const hono = app.getHonoApp();
    const internal = { error: { code: 'internal', message: 'Internal Server Error' } };
    for (const path of ['/foreign/server', '/foreign/client', '/foreign/middleware']) {
      errorSpy.mockClear();
      const response = await hono.request(path);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual(internal);
      // Report-first: the raw error reaches the server log.
      expect(errorSpy).toHaveBeenCalledOnce();
    }
  });

  it('reports and answers 500 for an HttpException thrown with a non-error status', async () => {
    @Controller('/moved')
    class MovedController {
      @Get()
      moved() {
        throw new HttpException('moved elsewhere', 302);
      }
    }
    const app = await appWith([MovedController]);
    const response = await app.getHonoApp().request('/moved');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 'internal', message: 'Internal Server Error' },
    });
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('renders validation failures as bad_request with the issue list', async () => {
    const CreateItem = z.object({ name: z.string().min(3) });
    @Controller('/items')
    class ItemsController {
      @Post()
      create(@Body(CreateItem) body: z.infer<typeof CreateItem>) {
        return body;
      }
    }
    const app = await appWith([ItemsController]);
    const response = await app.getHonoApp().request('/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: 'bad_request',
        message: 'Validation failed',
        details: { issues: [expect.objectContaining({ path: ['name'] })] },
      },
    });
    expect(body).not.toHaveProperty('statusCode');
  });
});

describe('exception filter results', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("defaults a non-Response result to the exception's status", async () => {
    @Catch()
    class ShapeFilter implements ExceptionFilter {
      catch(exception: unknown) {
        return { handled: exception instanceof Error ? exception.message : 'unknown' };
      }
    }

    @Controller('/filtered')
    @UseFilters(ShapeFilter)
    class FilteredController {
      @Get('/http')
      http() {
        throw new NotFoundException('gone');
      }

      @Get('/vela')
      vela() {
        throw new VelaError('conflict', { message: 'rev' });
      }

      @Get('/raw')
      raw() {
        throw new Error('raw');
      }
    }
    const app = await appWith([FilteredController]);
    const hono = app.getHonoApp();
    const http = await hono.request('/filtered/http');
    expect(http.status).toBe(404);
    expect(await http.json()).toEqual({ handled: 'gone' });
    expect((await hono.request('/filtered/vela')).status).toBe(409);
    expect((await hono.request('/filtered/raw')).status).toBe(500);
  });

  it('honors an explicit { status, body } result', async () => {
    @Catch()
    class ExplicitFilter implements ExceptionFilter {
      catch() {
        return { status: 422, body: { retry: false } };
      }
    }

    @Controller('/explicit')
    @UseFilters(ExplicitFilter)
    class ExplicitController {
      @Get()
      handle() {
        throw new NotFoundException();
      }
    }
    const app = await appWith([ExplicitController]);
    const response = await app.getHonoApp().request('/explicit');
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ retry: false });
  });

  it('falls through to the default renderer when a filter returns undefined', async () => {
    @Catch()
    class ObservingFilter implements ExceptionFilter {
      seen: unknown[] = [];
      catch(exception: unknown) {
        this.seen.push(exception);
        return undefined;
      }
    }

    @Controller('/observed')
    @UseFilters(ObservingFilter)
    class ObservedController {
      @Get()
      handle() {
        throw new NotFoundException('missing thing');
      }
    }
    const app = await appWith([ObservedController]);
    const response = await app.getHonoApp().request('/observed');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'not_found', message: 'missing thing' },
    });
  });

  it('offers unmatched routes and request limits to global filters without reporting them', async () => {
    const caught: unknown[] = [];
    @Catch()
    class EnvelopeFilter implements ExceptionFilter {
      catch(exception: unknown) {
        caught.push(exception);
        return { success: false, status: getErrorStatus(exception) };
      }
    }

    @Controller('/upload')
    class UploadController {
      @Post()
      handle() {
        return { ok: true };
      }
    }
    @Module({ controllers: [UploadController] })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, {
      security: { body: { maxBytes: 8 }, query: { maxParameters: 1 } },
    });
    app.useGlobalFilters(new EnvelopeFilter());
    const hono = app.getHonoApp();

    const missing = await hono.request('/missing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ success: false, status: 404 });
    const oversized = await hono.request('/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'far more than eight bytes' }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ success: false, status: 413 });
    const query = await hono.request('/upload?a=1&b=2', { method: 'POST' });
    expect(query.status).toBe(400);
    expect(await query.json()).toEqual({ success: false, status: 400 });
    expect(caught.map((error) => error?.constructor)).toEqual([
      NotFoundException,
      PayloadTooLargeException,
      BadRequestException,
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('applies the same result rules to middleware failures', async () => {
    @Catch()
    class GlobalFilter implements ExceptionFilter {
      catch() {
        return { blocked: true };
      }
    }

    @Controller('/mw')
    class MwController {
      @Get()
      handle() {
        return { ok: true };
      }
    }
    @Module({ controllers: [MwController] })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, {
      middleware: [
        async () => {
          throw new ForbiddenException();
        },
      ],
    });
    app.useGlobalFilters(new GlobalFilter());
    const response = await app.getHonoApp().request('/mw');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ blocked: true });
  });
});
