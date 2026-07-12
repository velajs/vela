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
  MetadataRegistry,
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
    MetadataRegistry.clear();
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
    expect(await res.json()).toEqual({ error: { code: 'internal', message: 'Internal Server Error' } });
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
    expect(await res.json()).toEqual({ error: { code: 'internal', message: 'Internal Server Error' } });
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
    MetadataRegistry.clear();
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
  it('probe: route.manager global-middleware raw-error boundary reaches onError (redacted, no leak)', async () => {
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

    // Documented observation: onError closes the raw-Error middleware boundary.
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: { code: 'internal', message: 'Internal Server Error' } });
    expect(JSON.stringify(body)).not.toContain('boundary secret');
    // Old `{ statusCode, message }` shape must NOT surface for raw errors.
    expect(body).not.toHaveProperty('statusCode');
  });

  // ---------------------------------------------------------------------------
  // Observability gap (whole-branch review): a hono HTTPException is returned
  // verbatim by onError. That is correct for the client-bound response, but a
  // 5xx hono exception is still a server fault — every other edge reports before
  // returning. onError must now report status>=500 HTTPExceptions before the
  // verbatim return, while leaving that response (and its status) untouched.
  // ---------------------------------------------------------------------------
  it('hono HTTPException status>=500 → verbatim response preserved AND reported once', async () => {
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

    // Client still gets hono's deliberate verbatim response — status unchanged.
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('upstream down');
    // ...and the 5xx server fault was reported exactly once.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('hono HTTPException status<500 (429) → verbatim response, NOT reported', async () => {
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
    expect(await res.text()).toContain('slow down');
    // 4xx author-intended client errors are NOT server faults — never reported.
    expect(errorSpy).toHaveBeenCalledTimes(0);
  });
});
