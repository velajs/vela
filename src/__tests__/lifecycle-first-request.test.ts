import { describe, expect, it, beforeEach } from 'vitest';
import {
  Controller,
  Get,
  Injectable,
  MetadataRegistry,
  Module,
  VelaFactory,
  type OnFirstRequest,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('OnFirstRequest', () => {
  it('fires exactly once before the first route handler runs', async () => {
    const fireOrder: string[] = [];

    @Injectable()
    class FirstRequestTracker implements OnFirstRequest {
      async onFirstRequest(): Promise<void> {
        fireOrder.push('onFirstRequest');
      }
    }

    @Controller('/probe')
    class ProbeController {
      constructor(private readonly _tracker: FirstRequestTracker) {}
      @Get()
      hit() {
        fireOrder.push('handler');
        return { ok: true };
      }
    }

    @Module({
      providers: [FirstRequestTracker],
      controllers: [ProbeController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    // Hook does not fire at bootstrap — only on the first request.
    expect(fireOrder).toEqual([]);

    const res = await app.getHonoApp().request('/probe');
    expect(res.status).toBe(200);
    expect(fireOrder).toEqual(['onFirstRequest', 'handler']);

    // Subsequent requests do not re-fire the hook.
    await app.getHonoApp().request('/probe');
    expect(fireOrder.filter((s) => s === 'onFirstRequest')).toHaveLength(1);
  });

  it('memoizes the fire under concurrent requests', async () => {
    let calls = 0;

    @Injectable()
    class SlowInit implements OnFirstRequest {
      async onFirstRequest(): Promise<void> {
        calls++;
        // Force a microtask boundary so a parallel request could race.
        await Promise.resolve();
      }
    }

    @Controller('/race')
    class RaceController {
      constructor(private readonly _init: SlowInit) {}
      @Get()
      hit() {
        return { ok: true };
      }
    }

    @Module({
      providers: [SlowInit],
      controllers: [RaceController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Fire 5 parallel "first" requests.
    const results = await Promise.all([
      hono.request('/race'),
      hono.request('/race'),
      hono.request('/race'),
      hono.request('/race'),
      hono.request('/race'),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(calls).toBe(1);
  });

  it('callOnFirstRequest() can be invoked manually before any HTTP request', async () => {
    let fired = false;

    @Injectable()
    class ManualFire implements OnFirstRequest {
      async onFirstRequest(): Promise<void> {
        fired = true;
      }
    }

    @Module({ providers: [ManualFire] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(fired).toBe(false);

    await app.callOnFirstRequest();
    expect(fired).toBe(true);

    // Idempotent — a second manual call doesn't re-fire.
    await app.callOnFirstRequest();
    expect(fired).toBe(true);
  });

  it('runs AFTER user-supplied middleware so binding initializers can run first', async () => {
    const order: string[] = [];

    @Injectable()
    class HookProbe implements OnFirstRequest {
      onFirstRequest(): void {
        order.push('hook');
      }
    }

    @Controller('/order')
    class OrderController {
      constructor(private readonly _h: HookProbe) {}
      @Get()
      hit() {
        order.push('handler');
        return { ok: true };
      }
    }

    @Module({
      providers: [HookProbe],
      controllers: [OrderController],
    })
    class AppModule {}

    // Pass a user middleware via BootstrapOptions — this is the seam
    // `@velajs/cloudflare`'s `createCloudflareApp` uses to inject env-binding
    // initialization. It must run BEFORE the OnFirstRequest hooks.
    const app = await VelaFactory.create(AppModule, {
      middleware: [
        async (_c, next) => {
          order.push('user-middleware');
          await next();
        },
      ],
    });

    await app.getHonoApp().request('/order');
    expect(order).toEqual(['user-middleware', 'hook', 'handler']);
  });
});
