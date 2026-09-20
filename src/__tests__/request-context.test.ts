import { defineProvider } from '../container/types';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  APP_INTERCEPTOR,
  Controller,
  Get,
  Inject,
  Injectable,
  MetadataRegistry,
  Module,
  REQUEST_CONTEXT,
  Scope,
  VelaFactory,
} from '../index.js';
import type { CallHandler, ExecutionContext, NestInterceptor, RequestContext } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('REQUEST_CONTEXT injectable', () => {
  it('gives each request a distinct id and isolated bag', async () => {
    const seen: Array<{ id: string; bagBefore: unknown; bagAfter: unknown }> = [];

    @Injectable({ scope: Scope.REQUEST })
    class CapturingInterceptor implements NestInterceptor {
      constructor(@Inject(REQUEST_CONTEXT) private readonly ctx: RequestContext) {}

      async intercept(_e: ExecutionContext, next: CallHandler): Promise<unknown> {
        const bagBefore = this.ctx.get('marker');
        this.ctx.set('marker', this.ctx.id);
        const bagAfter = this.ctx.get('marker');
        seen.push({ id: this.ctx.id, bagBefore, bagAfter });
        return next.handle();
      }
    }

    @Controller('/req-ctx')
    class C {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [
        CapturingInterceptor,
        defineProvider(APP_INTERCEPTOR, {useExisting: CapturingInterceptor}),
      ],
      controllers: [C],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const [r1, r2] = await Promise.all([hono.request('/req-ctx'), hono.request('/req-ctx')]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    expect(seen).toHaveLength(2);
    expect(seen[0]!.id).not.toBe(seen[1]!.id);
    // Each request starts with an empty bag.
    expect(seen[0]!.bagBefore).toBeUndefined();
    expect(seen[1]!.bagBefore).toBeUndefined();
    // And `set` writes survive within the same request.
    expect(seen[0]!.bagAfter).toBe(seen[0]!.id);
    expect(seen[1]!.bagAfter).toBe(seen[1]!.id);
  });

  it('mirrors an inbound x-request-id header into ctx.id', async () => {
    let captured: string | undefined;

    @Injectable({ scope: Scope.REQUEST })
    class IdInterceptor implements NestInterceptor {
      constructor(@Inject(REQUEST_CONTEXT) private readonly ctx: RequestContext) {}
      intercept(_e: ExecutionContext, next: CallHandler): Promise<unknown> | unknown {
        captured = this.ctx.id;
        return next.handle();
      }
    }

    @Controller('/req-id')
    class C {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [IdInterceptor, defineProvider(APP_INTERCEPTOR, {useExisting: IdInterceptor})],
      controllers: [C],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/req-id', {
      headers: { 'x-request-id': 'caller-supplied-id-123' },
    });
    expect(res.status).toBe(200);
    expect(captured).toBe('caller-supplied-id-123');
  });

  it('exposes the raw Request and Hono Context', async () => {
    let capturedRawSame = false;
    let capturedHonoSame = false;

    @Injectable({ scope: Scope.REQUEST })
    class PeekingInterceptor implements NestInterceptor {
      constructor(@Inject(REQUEST_CONTEXT) private readonly ctx: RequestContext) {}
      intercept(e: ExecutionContext, next: CallHandler): Promise<unknown> | unknown {
        const http = e.switchToHttp();
        capturedHonoSame = this.ctx.hono === http.getResponse();
        capturedRawSame = this.ctx.request === http.getRequest();
        return next.handle();
      }
    }

    @Controller('/peek')
    class C {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [
        PeekingInterceptor,
        defineProvider(APP_INTERCEPTOR, {useExisting: PeekingInterceptor}),
      ],
      controllers: [C],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/peek');
    expect(res.status).toBe(200);
    expect(capturedHonoSame).toBe(true);
    expect(capturedRawSame).toBe(true);
  });

  it('throws when resolved outside the request path', async () => {
    @Module({})
    class AppModule {}
    const app = await VelaFactory.create(AppModule);
    expect(() => app.get(REQUEST_CONTEXT)).toThrow(/REQUEST_CONTEXT can only be resolved/);
  });
});
