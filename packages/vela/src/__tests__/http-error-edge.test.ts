import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  VelaFactory,
  Controller,
  Get,
  Module,
  Catch,
  UseFilters,
  NotFoundException,
  BadRequestException,
  BadGatewayException,
  HttpException,
  InternalServerErrorException,
  NotAcceptableException,
} from '../index.js';
import type { ExceptionFilter, ExecutionContext } from '../index.js';
import { VelaError } from '@velajs/errors';

// =============================================================================
// Task 7 — HTTP edge: HandlerExecutor on report-first ordering + canonical body
//
// The handler-executor catch tail now:
//   1. reports EVERY error first (logging owned by the reporter),
//   2. lets exception filters render (a throwing filter is itself reported,
//      then falls through to the default render),
//   3. emits the canonical `{ error: { code, message, details? } }` wire body,
//      except HttpException object responses which ship verbatim (crud compat).
// =============================================================================

describe('HTTP error edge — report-first ordering + canonical body', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('string HttpException → canonical { error: { code, message } }', async () => {
    @Controller('/bare-http')
    class BareController {
      @Get()
      handle() {
        throw new NotFoundException('missing thing');
      }
    }

    @Module({ controllers: [BareController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/bare-http');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'missing thing' } });
  });

  it('object HttpException → shipped verbatim (crud envelope compat)', async () => {
    @Controller('/object-http')
    class ObjectController {
      @Get()
      handle() {
        throw new BadRequestException({ custom: 'shape', reason: 'legacy' });
      }
    }

    @Module({ controllers: [ObjectController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/object-http');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ custom: 'shape', reason: 'legacy' });
  });

  it('VelaError → canonical body with code + details from data', async () => {
    @Controller('/vela-error')
    class VelaErrorController {
      @Get()
      handle() {
        throw new VelaError('conflict', { message: 'rev mismatch', data: { rev: 3 } });
      }
    }

    @Module({ controllers: [VelaErrorController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/vela-error');

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: 'conflict', message: 'rev mismatch', details: { rev: 3 } },
    });
  });

  it('unknown error → redacted 500 canonical body; reported once', async () => {
    @Controller('/unknown')
    class UnknownController {
      @Get()
      handle() {
        throw new Error('secret sauce');
      }
    }

    @Module({ controllers: [UnknownController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/unknown');

    expect(res.status).toBe(500);
    // Raw message never echoed — redacted to the catalog title.
    expect(await res.json()).toEqual({
      error: { code: 'internal', message: 'Internal Server Error' },
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('throwing exception filter → original + filter both reported, redacted 500', async () => {
    @Catch()
    class ThrowingFilter implements ExceptionFilter {
      catch(_exception: unknown, _host: ExecutionContext): never {
        throw new Error('filter boom');
      }
    }

    @Controller('/filter-throws')
    @UseFilters(new ThrowingFilter())
    class FilterThrowsController {
      @Get()
      handle() {
        throw new Error('original');
      }
    }

    @Module({ controllers: [FilterThrowsController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/filter-throws');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'internal', message: 'Internal Server Error' },
    });
    // Report FIRST always: original error + the exception-filter-threw report.
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Task 8 — hono `app.onError`: hono/middleware-level errors can no longer
// bypass report + redaction.
//
// HandlerExecutor's catch tail only sees controller-handler errors. A raw
// Hono middleware registered directly on the app (bypassing vela's
// wrapMiddlewareWithFilters wrapping entirely) throws straight into Hono's
// outer error path. `app.onError` is the last line of defense: it must report
// the error once and emit the canonical, redacted body — never the raw
// message.
// =============================================================================

describe('hono app.onError — hono/middleware errors cannot bypass report + redaction', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('raw hono middleware error (bypasses vela wrapping) → reported once + redacted 500', async () => {
    @Controller('/ok')
    class OkController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({ controllers: [OkController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    // Registered directly on the built Hono app — this middleware is NOT run
    // through route.manager's wrapMiddlewareWithFilters, so nothing but
    // `app.onError` can intercept its throw. Request an unmatched path so the
    // `*` middleware is the only handler in the chain.
    app.getHonoApp().use('*', async (_c: Context, _next: Next) => {
      throw new Error('middleware secret');
    });

    const res = await app.getHonoApp().request('/boom');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: { code: 'internal', message: 'Internal Server Error' } });
    // Raw message never echoed to the client.
    expect(JSON.stringify(body)).not.toContain('middleware secret');
    // onError reports exactly once via the shared reporter.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Diagnostic probe (Task 7 review follow-up): a route.manager-level GLOBAL
  // middleware throwing a *raw* Error. wrapMiddlewareWithFilters catches it,
  // finds no filter + non-HttpException, and re-throws to Hono's outer handler.
  // We observe what body reaches the client now that onError is wired.
  // This test only DOCUMENTS the observed behavior — it does not fix
  // route.manager.
  // ---------------------------------------------------------------------------
  it('vela global-middleware errors are reported and redacted without leaking details', async () => {
    @Controller('/probe')
    class ProbeController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({ controllers: [ProbeController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, {
      middleware: [
        async (_c: Context, _next: Next) => {
          throw new Error('boundary secret');
        },
      ],
    });

    const res = await app.getHonoApp().request('/probe');
    const body = await res.json();

    // The middleware boundary reports and renders raw errors exactly once.
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: { code: 'internal', message: 'Internal Server Error' } });
    expect(JSON.stringify(body)).not.toContain('boundary secret');
    // Old `{ statusCode, message }` shape must NOT surface for raw errors.
    expect(body).not.toHaveProperty('statusCode');
  });

  // ---------------------------------------------------------------------------
  // A hono HTTPException can carry arbitrary provider/middleware text. 5xx
  // responses retain their status but are reported and redacted at the edge.
  // ---------------------------------------------------------------------------
  it('hono HTTPException status>=500 → response redacted AND reported once', async () => {
    @Controller('/ok')
    class OkController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({ controllers: [OkController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    // Raw hono middleware throwing hono's own HTTPException — reaches onError
    // directly (not through vela's wrapping).
    app.getHonoApp().use('*', async (_c: Context, _next: Next) => {
      throw new HTTPException(503, { message: 'upstream down' });
    });

    const res = await app.getHonoApp().request('/boom');

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: { code: 'internal', message: 'Internal Server Error' } });
    expect(JSON.stringify(body)).not.toContain('upstream down');
    // ...and the 5xx server fault was reported exactly once.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a fractional 4xx', 404.5],
    ['NaN', Number.NaN],
    ['a status above 599', 700],
  ])(
    'hono HTTPException with %s status → rendered as a redacted 500 AND reported',
    async (_label, status) => {
      @Controller('/ok')
      class OkController {
        @Get()
        handle() {
          return { ok: true };
        }
      }

      @Module({ controllers: [OkController] })
      class AppModule {}

      const reported: unknown[] = [];
      const app = await VelaFactory.create(AppModule);
      const failure = new HTTPException(404, { message: 'odd status secret' });
      // A JavaScript caller can construct one with any status.
      Object.defineProperty(failure, 'status', { value: status });
      app.getHonoApp().use('*', async (_c: Context, _next: Next) => {
        throw failure;
      });

      const res = await app.getHonoApp().request('/boom');
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: { code: 'internal', message: 'Internal Server Error' } });
      // The default reporter logs it: a status it cannot answer is no client fault.
      expect(errorSpy).toHaveBeenCalledTimes(1);

      // A custom reporter receives it from the raw edge too.
      app.useGlobalExceptionHandler({
        report: (error) => {
          reported.push(error);
        },
      });
      await app.getHonoApp().request('/boom');
      expect(reported).toEqual([failure]);
    },
  );

  it('hono HTTPException status<500 (429) → its message as JSON, NOT reported', async () => {
    @Controller('/ok')
    class OkController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({ controllers: [OkController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    app.getHonoApp().use('*', async (_c: Context, _next: Next) => {
      throw new HTTPException(429, { message: 'slow down' });
    });

    const res = await app.getHonoApp().request('/boom');

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: { code: 'too_many_requests', message: 'slow down' },
    });
    // 4xx author-intended client errors are NOT server faults — never reported.
    expect(errorSpy).toHaveBeenCalledTimes(0);
  });
});

// =============================================================================
// String HttpException rendering is identical on every HTTP edge: 5xx (and any
// status whose code resolves to `internal`) never echoes the caller's text,
// and unmapped statuses derive their code from the status class.
// =============================================================================

describe('string HttpException — redaction and status-class codes on every HTTP edge', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  const cases: Array<{ name: string; make: () => Error; status: number; body: unknown }> = [
    {
      name: '500 InternalServerErrorException',
      make: () => new InternalServerErrorException('db password=hunter2'),
      status: 500,
      body: { error: { code: 'internal', message: 'Internal Server Error' } },
    },
    {
      name: '502 BadGatewayException',
      make: () => new BadGatewayException('upstream host=10.0.0.5 refused'),
      status: 502,
      body: { error: { code: 'bad_gateway', message: 'Bad Gateway' } },
    },
    {
      name: 'unmapped 5xx HttpException',
      make: () => new HttpException('storage node 7 full', 507),
      status: 507,
      body: { error: { code: 'internal', message: 'Internal Server Error' } },
    },
    {
      name: '406 NotAcceptableException',
      make: () => new NotAcceptableException('only text/csv is available'),
      status: 406,
      body: { error: { code: 'not_acceptable', message: 'only text/csv is available' } },
    },
    {
      name: '412 HttpException',
      make: () => new HttpException('etag mismatch', 412),
      status: 412,
      body: { error: { code: 'precondition_failed', message: 'etag mismatch' } },
    },
    {
      name: 'unmapped 4xx HttpException',
      make: () => new HttpException('short and stout', 418),
      status: 418,
      body: { error: { code: 'bad_request', message: 'short and stout' } },
    },
  ];

  for (const { name, make, status, body } of cases) {
    it(`handler: ${name}`, async () => {
      @Controller('/edge')
      class EdgeController {
        @Get()
        handle() {
          throw make();
        }
      }

      @Module({ controllers: [EdgeController] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const res = await app.getHonoApp().request('/edge');

      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
    });

    it(`vela middleware: ${name}`, async () => {
      @Controller('/edge')
      class EdgeController {
        @Get()
        handle() {
          return { ok: true };
        }
      }

      @Module({ controllers: [EdgeController] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, {
        middleware: [
          async (_c: Context, _next: Next) => {
            throw make();
          },
        ],
      });
      const res = await app.getHonoApp().request('/edge');

      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
    });

    it(`hono onError: ${name}`, async () => {
      @Controller('/ok')
      class OkController {
        @Get()
        handle() {
          return { ok: true };
        }
      }

      @Module({ controllers: [OkController] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      // Registered on the built Hono app, so only `onError` sees the throw.
      app.getHonoApp().use('*', async (_c: Context, _next: Next) => {
        throw make();
      });
      const res = await app.getHonoApp().request('/boom');

      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
    });
  }

  it('hono onError: object 5xx HttpException is redacted to the status title', async () => {
    @Controller('/ok')
    class OkController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({ controllers: [OkController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.getHonoApp().use('*', async (_c: Context, _next: Next) => {
      throw new HttpException({ reason: 'db password=hunter2' }, 503);
    });
    const res = await app.getHonoApp().request('/boom');

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'service_unavailable', message: 'Service Unavailable' },
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('hono onError: object 4xx HttpException ships verbatim', async () => {
    @Controller('/ok')
    class OkController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({ controllers: [OkController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.getHonoApp().use('*', async (_c: Context, _next: Next) => {
      throw new BadRequestException({ custom: 'shape' });
    });
    const res = await app.getHonoApp().request('/boom');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ custom: 'shape' });
  });

  it('vela middleware: object HttpException ships verbatim', async () => {
    @Controller('/edge')
    class EdgeController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({ controllers: [EdgeController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, {
      middleware: [
        async (_c: Context, _next: Next) => {
          throw new BadRequestException({ custom: 'shape' });
        },
      ],
    });
    const res = await app.getHonoApp().request('/edge');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ custom: 'shape' });
  });
});
