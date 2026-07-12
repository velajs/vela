import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
