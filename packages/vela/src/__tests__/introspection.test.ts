import { defineProvider } from '../container/types';
import { describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Global,
  Head,
  Injectable,
  InjectionToken,
  Module,
  Post,
  VelaFactory,
} from '../index.js';
import { describeToken, type ModuleDescription } from '../module-kit.js';
import { ROOT_MODULE_ID } from '../internal.js';

describe('describeRoutes / getGlobalPrefix', () => {
  it('records fully composed paths, methods as declared, and versions', async () => {
    @Controller({ path: 'users', version: 1 })
    class UsersController {
      @Get(':id')
      getOne() {
        return {};
      }

      @Post()
      create() {
        return {};
      }

      @Head('ping')
      ping() {
        return {};
      }
    }

    @Module({ controllers: [UsersController] })
    class App {}

    const app = await VelaFactory.create(App, { globalPrefix: '/api' });
    const routes = app.describeRoutes();

    expect(app.getGlobalPrefix()).toBe('/api');
    expect(routes).toEqual(
      expect.arrayContaining([
        {
          method: 'GET',
          path: '/api/v1/users/:id',
          controller: 'UsersController',
          handler: 'getOne',
          moduleId: 'App#default',
          version: 1,
        },
        {
          method: 'POST',
          path: '/api/v1/users',
          controller: 'UsersController',
          handler: 'create',
          moduleId: 'App#default',
          version: 1,
        },
        {
          method: 'HEAD',
          path: '/api/v1/users/ping',
          controller: 'UsersController',
          handler: 'ping',
          moduleId: 'App#default',
          version: 1,
        },
      ]),
    );
    // Every recorded path is actually served (registered on Hono).
    expect((await app.getHonoApp().request('/api/v1/users/42')).status).toBe(200);
    await app.dispose();
  });

  it('expands multi-version routes into one row per version', async () => {
    @Controller({ path: '/multi', version: [1, 2] })
    class MultiController {
      @Get('thing')
      thing() {
        return {};
      }
    }

    @Module({ controllers: [MultiController] })
    class App {}

    const app = await VelaFactory.create(App);
    const rows = app.describeRoutes().filter((r) => r.handler === 'thing');
    expect(rows.map((r) => [r.path, r.version])).toEqual([
      ['/v1/multi/thing', 1],
      ['/v2/multi/thing', 2],
    ]);
    await app.dispose();
  });
});

describe('Container.getModuleDescriptions', () => {
  it('describes modules with imports, exports, lazy flag, and the root bucket', async () => {
    const SHARED = new InjectionToken<string>('introspect:shared');

    @Injectable()
    class LazyThing {}

    @Module({ lazy: true, providers: [LazyThing] })
    class LazyMod {}

    @Module({
      providers: [defineProvider(SHARED, { useValue: 'x' })],
      exports: [SHARED],
    })
    class SharedMod {}

    @Module({ imports: [SharedMod, LazyMod] })
    class App {}

    const app = await VelaFactory.create(App);
    const modules = app.getContainer().getModuleDescriptions();
    const byId = new Map(modules.map((m) => [m.moduleId, m]));

    const appDesc = byId.get('App#default')!;
    expect(appDesc.imports).toEqual(
      expect.arrayContaining(['SharedMod#default', 'LazyMod#default']),
    );
    expect(appDesc.lazy).toBe(false);

    const shared = byId.get('SharedMod#default')!;
    expect(shared.exports).toEqual(['InjectionToken(introspect:shared)']);
    expect(shared.providers).toContain('InjectionToken(introspect:shared)');

    expect(byId.get('LazyMod#default')!.lazy).toBe(true);
    expect(byId.get('LazyMod#default')!.providers).toContain('LazyThing');

    const root = byId.get(ROOT_MODULE_ID)!;
    expect(root.imports).toEqual([]);
    expect(root.providers).toContain('Container');
    await app.dispose();
  });

  it('names global modules `global`, as ModuleMetadata and DynamicModule do', async () => {
    const TOKEN = new InjectionToken<string>('introspect:global');

    @Global()
    @Module({ providers: [defineProvider(TOKEN, { useValue: 'x' })], exports: [TOKEN] })
    class GlobalMod {}

    @Module({})
    class LocalMod {}

    @Module({ imports: [GlobalMod, LocalMod] })
    class App {}

    const app = await VelaFactory.create(App);
    try {
      const modules = app.getContainer().getModuleDescriptions();
      const byId = new Map(modules.map((m) => [m.moduleId, m]));
      const global: ModuleDescription | undefined = byId.get('GlobalMod#default');
      expect(global?.global).toBe(true);
      expect(byId.get('LocalMod#default')?.global).toBe(false);
      expect(modules.every((m) => !Object.hasOwn(m, 'isGlobal'))).toBe(true);
    } finally {
      await app.dispose();
    }
  });
});

describe('describeToken', () => {
  it('labels classes, injection tokens, symbols, and strings', () => {
    class Foo {}
    expect(describeToken(Foo)).toBe('Foo');
    expect(describeToken(new InjectionToken('desc'))).toBe('InjectionToken(desc)');
    expect(describeToken(Symbol.for('s'))).toBe('Symbol(s)');
    expect(describeToken('plain')).toBe('plain');
  });
});
