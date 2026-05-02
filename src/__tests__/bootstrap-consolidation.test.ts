import { beforeEach, describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  MetadataRegistry,
  Module,
  ModuleRef,
  VelaApplication,
  VelaFactory,
} from '../index.js';
import { Container } from '../internal.js';
import { bootstrap } from '../factory/bootstrap.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('bootstrap()', () => {
  it('returns { container, routeManager, loader } shape', async () => {
    @Module({})
    class App {}

    const result = await bootstrap(App);
    expect(result.container).toBeInstanceOf(Container);
    expect(result.routeManager).toBeDefined();
    expect(result.loader).toBeDefined();
  });

  it('does NOT run lifecycle hooks (no OnModuleInit observable)', async () => {
    let initCalled = false;

    @Injectable()
    class Service {
      onModuleInit() {
        initCalled = true;
      }
    }

    @Module({ providers: [Service] })
    class App {}

    await bootstrap(App);
    expect(initCalled).toBe(false);
  });

  it('does NOT eagerly resolve provider instances', async () => {
    let constructed = false;

    @Injectable()
    class EagerSvc {
      constructor() {
        constructed = true;
      }
    }

    @Module({ providers: [EagerSvc] })
    class App {}

    await bootstrap(App);
    expect(constructed).toBe(false);
  });

  it('does NOT build the Hono app (caller does it via VelaApplication.initRoutes)', async () => {
    @Module({})
    class App {}

    const result = await bootstrap(App);
    // VelaApplication.getApp throws until initRoutes is called
    const application = new VelaApplication(result.container, result.routeManager);
    expect(() => application.getHonoApp()).toThrow(/Routes not built/);
  });

  it('registers Container and ModuleRef as global; resolvable from any module', async () => {
    @Injectable()
    class UsesPrimitives {
      constructor(public c: Container, public m: ModuleRef) {}
    }

    @Module({ providers: [UsesPrimitives] })
    class App {}

    const { container } = await bootstrap(App, { strict: true });
    const u = container.resolve(UsesPrimitives, 'App');
    expect(u.c).toBe(container);
    expect(u.m).toBeInstanceOf(ModuleRef);
  });

  it('honors options.globalPrefix on the route manager', async () => {
    @Controller('/users')
    class UsersCtl {
      @Get()
      list() {
        return [];
      }
    }

    @Module({ controllers: [UsersCtl] })
    class App {}

    const app = await VelaFactory.create(App, { globalPrefix: '/api' });
    const res = await app.getHonoApp().request('/api/users');
    expect(res.status).toBe(200);
  });

  it('honors options.middleware as global middleware', async () => {
    @Controller('/x')
    class Ctl {
      @Get()
      h() {
        return { ok: true };
      }
    }

    @Module({ controllers: [Ctl] })
    class App {}

    let mwCalls = 0;
    const app = await VelaFactory.create(App, {
      middleware: [
        async (_c, next) => {
          mwCalls++;
          await next();
        },
      ],
    });
    await app.getHonoApp().request('/x');
    expect(mwCalls).toBe(1);
  });

  it('VelaFactory.create returns a working VelaApplication (parity with pre-1.2)', async () => {
    @Controller('/health')
    class HealthCtl {
      @Get()
      h() {
        return { status: 'ok' };
      }
    }

    @Module({ controllers: [HealthCtl] })
    class App {}

    const app = await VelaFactory.create(App);
    expect(app.fetch).toBeDefined();
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('VelaFactory.create propagates strict to the container (default true; opt out with false)', async () => {
    const TOKEN = new InjectionToken<string>('TOK');

    @Injectable()
    class Consumer {
      constructor(@Inject(TOKEN) public v: string) {}
    }

    @Module({
      providers: [{ provide: TOKEN, useValue: 'x' }],
      // Note: TOKEN is NOT exported
    })
    class ModA {}

    @Module({ imports: [ModA], providers: [Consumer] })
    class ModB {}

    // Default (strict: true) → rejects because TOKEN isn't exported
    await expect(VelaFactory.create(ModB)).rejects.toThrow(/cannot resolve/);

    // strict: false explicitly opts out → succeeds
    MetadataRegistry.clear();
    @Module({ providers: [{ provide: TOKEN, useValue: 'x' }] })
    class ModA2 {}
    @Module({ imports: [ModA2], providers: [Consumer] })
    class ModB2 {}
    const app = await VelaFactory.create(ModB2, { strict: false });
    expect(app.get(Consumer).v).toBe('x');
  });
});
