import { describe, expect, it } from 'vitest';
import { createDiPlaygroundApp } from '../src/app.js';

type DiFixture = Awaited<ReturnType<typeof createDiPlaygroundApp>>;

async function withFixture(fn: (fixture: DiFixture) => Promise<void>): Promise<void> {
  const fixture = await createDiPlaygroundApp();
  try {
    await fn(fixture);
  } finally {
    await fixture.app.close('test-complete');
  }
}

describe('DI Playground API example app', () => {
  it('covers global modules, dynamic module refs, forward refs, ModuleRef, and Container', async () => {
    await withFixture(async ({ app }) => {
      const hono = app.getHonoApp();

      expect(await (await hono.request('/api/playground/global')).json()).toEqual({
        message: 'global-ready',
      });

      expect(await (await hono.request('/api/playground/dynamic')).json()).toEqual({
        audit: 'dynamic-audit-ready',
      });

      expect(await (await hono.request('/api/playground/forward-ref')).json()).toEqual({
        provider: 'alpha:beta:alpha-linked',
        module: { a: 'from-module-a', b: 'from-module-b' },
        manual: true,
      });

      expect(await (await hono.request('/api/playground/module-ref')).json()).toEqual({
        singletonCount: 3,
        sameSingleton: true,
        freshCount: 1,
        freshIsSingleton: false,
      });

      expect(await (await hono.request('/api/playground/container')).json()).toEqual({
        ping: 'sandbox-tool-ready',
      });
    });
  });

  it('covers mixin guards, ZodValidationPipe, adapter helpers, logger, and streaming', async () => {
    await withFixture(async ({ app }) => {
      const hono = app.getHonoApp();

      const adminDenied = await hono.request('/api/playground/mixin/admin');
      expect(adminDenied.status).toBe(403);

      const adminAllowed = await hono.request('/api/playground/mixin/admin', {
        headers: { 'x-role': 'admin' },
      });
      expect(adminAllowed.status).toBe(200);
      expect(await adminAllowed.json()).toEqual({ role: 'admin' });

      const maintainerAllowed = await hono.request('/api/playground/mixin/maintainer', {
        headers: { 'x-role': 'maintainer' },
      });
      expect(maintainerAllowed.status).toBe(200);

      const zod = await hono.request('/api/playground/zod', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'probe-a', count: 2 }),
      });
      expect(zod.status).toBe(200);
      expect(await zod.json()).toEqual({ parsed: { name: 'probe-a', count: 2 } });

      const runtime = await hono.request('/api/playground/runtime');
      expect(runtime.status).toBe(200);
      expect(await runtime.json()).toEqual({
        runtime: 'node',
        hasEnvironment: true,
      });

      expect(await (await hono.request('/api/playground/logger')).json()).toEqual({
        logLevel: 2,
        captured: 1,
        hasContext: true,
      });

      const stream = await hono.request('/api/playground/stream');
      expect(stream.status).toBe(200);
      expect(await stream.text()).toBe('alpha\nomega\n');
    });
  });
});
