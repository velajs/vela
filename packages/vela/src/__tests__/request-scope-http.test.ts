import { defineProvider } from '../container/types';
import { describe, it, expect } from 'vitest';
import { APP_GUARD, Controller, Get, Injectable, Module, Scope, VelaFactory } from '../index.js';
import type { CanActivate, ExecutionContext } from '../index.js';

describe('HTTP request scope', () => {
  it('should resolve request-scoped APP_GUARD providers per request', async () => {
    const seenIds: number[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class RequestContextValue {
      id = Math.random();
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestScopedGuard implements CanActivate {
      constructor(private readonly ctxValue: RequestContextValue) {}

      canActivate(_context: ExecutionContext): boolean {
        seenIds.push(this.ctxValue.id);
        return true;
      }
    }

    @Controller('/request-scope')
    class TestController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [
        RequestContextValue,
        RequestScopedGuard,
        defineProvider(APP_GUARD, { useExisting: RequestScopedGuard }),
      ],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const first = await hono.request('/request-scope');
    const second = await hono.request('/request-scope');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(seenIds).toHaveLength(2);
    expect(seenIds[0]).not.toBe(seenIds[1]);
  });
});
