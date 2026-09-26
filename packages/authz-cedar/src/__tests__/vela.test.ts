import { describe, expect, it, vi } from 'vitest';
import {
  defineProvider,
  APP_GUARD,
  Controller,
  Get,
  Module,
  Reflector,
  UseGuards,
  VelaFactory,
  type GuardPhase,
} from '@velajs/vela';
import {
  setTrustedRequestIdentity,
  clearTrustedRequestIdentity,
  orderGuardsByPhase,
  SkipGuardPhases,
} from '@velajs/vela/module-kit';
import { Test } from '@velajs/testing';
import {
  auditCedarRoutes,
  CedarGuard,
  CedarModule,
  CedarPublic,
  RequireResource,
} from '../vela/index';
const principal = { issuer: 'test', subject: 'alice', principalType: 'user' } as const;
const route = (path: string) => {
  class Routes {
    read() {
      return { path };
    }
  }
  Controller(path)(Routes);
  Get()(Routes.prototype, 'read', Object.getOwnPropertyDescriptor(Routes.prototype, 'read')!);
  return Routes;
};
describe('resource authorization declarations', () => {
  it('reads declarations through the application Reflector', async () => {
    class Routes {
      read() {
        return { public: true };
      }
    }
    Controller('/open')(Routes);
    Get()(Routes.prototype, 'read', Object.getOwnPropertyDescriptor(Routes.prototype, 'read')!);
    CedarPublic()(Routes);
    class App {}
    Module({
      providers: [{ provide: APP_GUARD, useExisting: CedarGuard }],
      controllers: [Routes],
      imports: [CedarModule.forRoot({ authorize: async () => false })],
    })(App);
    const app = await VelaFactory.create(App);
    try {
      const reads = vi.spyOn(app.get(Reflector), 'getAllAndOverride');
      expect((await app.getHonoApp().request('/open')).status).toBe(200);
      expect(reads).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
  it('audits handlers and permits explicit public/class declarations', () => {
    class Routes {
      read() {
        return {};
      }
    }
    Controller('/audit')(Routes);
    Get()(Routes.prototype, 'read', Object.getOwnPropertyDescriptor(Routes.prototype, 'read')!);
    class App {}
    Module({ controllers: [Routes] })(App);
    expect(() => auditCedarRoutes([App])).toThrow('Routes.read');
    CedarPublic()(Routes);
    expect(() => auditCedarRoutes([App])).not.toThrow();
  });
  it('audits and authorizes a declaration an ancestor makes on a method the controller inherits', async () => {
    class Base {
      read() {
        return { ok: true };
      }
    }
    const read = Object.getOwnPropertyDescriptor(Base.prototype, 'read')!;
    RequireResource({ action: 'read', resourceType: 'Doc' })(Base.prototype, 'read', read);
    class Routes extends Base {}
    Controller('/inherited')(Routes);
    Get()(Routes.prototype, 'read', read);
    const requirements: string[] = [];
    class App {}
    Module({
      providers: [{ provide: APP_GUARD, useExisting: CedarGuard }],
      controllers: [Routes],
      imports: [
        CedarModule.forRoot({
          auditModules: [App],
          authorize: async ({ requirement }) => {
            requirements.push(`${requirement.action}:${requirement.resourceType}`);
            return true;
          },
        }),
      ],
    })(App);
    expect(() => auditCedarRoutes([App])).not.toThrow();
    const app = await VelaFactory.create(App, {
      middleware: [
        async (c, next) => {
          setTrustedRequestIdentity(c.req.raw, { principal, tenantId: 'a' });
          await next();
        },
      ],
    });
    try {
      expect((await app.getHonoApp().request('/inherited')).status).toBe(200);
      expect(requirements).toEqual(['read:Doc']);
    } finally {
      await app.close();
    }
  });
  it('requires verified identities, honors denial and fails if authority changes during a check', async () => {
    let allowed = true,
      clear = false,
      calls = 0;
    class Routes {
      read() {
        return { ok: true };
      }
      public() {
        return { public: true };
      }
    }
    Controller('/docs')(Routes);
    Get('/item/:id')(
      Routes.prototype,
      'read',
      Object.getOwnPropertyDescriptor(Routes.prototype, 'read')!,
    );
    RequireResource({ action: 'read', resourceType: 'Doc', idParam: 'id' })(
      Routes.prototype,
      'read',
      Object.getOwnPropertyDescriptor(Routes.prototype, 'read')!,
    );
    Get('/public')(
      Routes.prototype,
      'public',
      Object.getOwnPropertyDescriptor(Routes.prototype, 'public')!,
    );
    CedarPublic()(
      Routes.prototype,
      'public',
      Object.getOwnPropertyDescriptor(Routes.prototype, 'public')!,
    );
    class App {}
    Module({
      providers: [{ provide: APP_GUARD, useExisting: CedarGuard }],
      controllers: [Routes],
      imports: [
        CedarModule.forRoot({
          auditModules: [App],
          authorize: async ({ requirement, identity, context }) => {
            expect(requirement.resourceType).toBe('Doc');
            expect(identity.principal.subject).toBe('alice');
            calls++;
            if (clear) clearTrustedRequestIdentity(context.getRequest());
            return allowed;
          },
        }),
      ],
    })(App);
    const app = await VelaFactory.create(App, {
      middleware: [
        async (c, next) => {
          if (c.req.header('x-auth'))
            setTrustedRequestIdentity(c.req.raw, { principal, tenantId: 'a' });
          await next();
        },
      ],
    });
    try {
      expect((await app.getHonoApp().request('/docs/item/42')).status).toBe(403);
      expect(calls).toBe(0);
      expect(
        (await app.getHonoApp().request('/docs/item/42', { headers: { 'x-auth': 'yes' } })).status,
      ).toBe(200);
      allowed = false;
      expect(
        (await app.getHonoApp().request('/docs/item/42', { headers: { 'x-auth': 'yes' } })).status,
      ).toBe(403);
      allowed = true;
      clear = true;
      expect(
        (await app.getHonoApp().request('/docs/item/42', { headers: { 'x-auth': 'yes' } })).status,
      ).toBe(403);
      expect((await app.getHonoApp().request('/docs/public')).status).toBe(200);
    } finally {
      await app.close();
    }
  });
  it('denies undeclared routes on every application route by default', async () => {
    expect(CedarGuard.phase).toBe('authorize');
    // An application subclass redeclares `skippable` to run on integration routes too.
    class StrictCedarGuard extends CedarGuard {
      static override readonly skippable = false;
    }
    expect(
      orderGuardsByPhase([CedarGuard, StrictCedarGuard], new Set<GuardPhase>(['authorize'])),
    ).toEqual([StrictCedarGuard]);
    const Undeclared = route('/undeclared');
    const Elsewhere = route('/elsewhere');
    // An integration's own controller leaves authorization to the integration.
    const Integration = route('/integration');
    SkipGuardPhases(['authorize'])(Integration);
    class Outside {}
    Module({ controllers: [Elsewhere, Integration] })(Outside);
    const build = (
      options: {
        undeclared?: 'deny' | 'allow';
        isGlobal?: boolean;
      },
      installGuard = true,
    ) => {
      class App {}
      Module({
        providers: [
          ...(installGuard ? [defineProvider(APP_GUARD, { useExisting: CedarGuard })] : []),
        ],
        controllers: [Undeclared],
        imports: [CedarModule.forRoot({ authorize: async () => true, ...options }), Outside],
      })(App);
      return VelaFactory.create(App);
    };
    // Whether or not every module can see CedarModule, the phase covers the same routes.
    for (const options of [{}, { isGlobal: true }]) {
      const strict = await build(options);
      try {
        const hono = strict.getHonoApp();
        expect((await hono.request('/undeclared')).status).toBe(403);
        // A module that does not import CedarModule is still an application module.
        expect((await hono.request('/elsewhere')).status).toBe(403);
        expect((await hono.request('/integration')).status).toBe(200);
      } finally {
        await strict.close();
      }
    }
    for (const relaxed of [await build({ undeclared: 'allow' }), await build({}, false)]) {
      try {
        expect((await relaxed.getHonoApp().request('/undeclared')).status).toBe(200);
        expect((await relaxed.getHonoApp().request('/elsewhere')).status).toBe(200);
      } finally {
        await relaxed.close();
      }
    }
  });
  it('resolves undeclared-route policy through the async options factory', async () => {
    const authorize = async () => true;
    const Undeclared = route('/undeclared');
    const statuses: number[] = [];
    for (const undeclared of [undefined, 'deny', 'allow'] as const) {
      class App {}
      Module({
        providers: [{ provide: APP_GUARD, useExisting: CedarGuard }],
        controllers: [Undeclared],
        imports: [
          CedarModule.forRootAsync({
            useFactory: async () => ({
              authorize,
              ...(undeclared === undefined ? {} : { undeclared }),
            }),
          }),
        ],
      })(App);
      const app = await VelaFactory.create(App);
      try {
        statuses.push((await app.getHonoApp().request('/undeclared')).status);
      } finally {
        await app.close();
      }
    }
    expect(statuses).toEqual([403, 403, 200]);
  });
  it('authorizes routes in modules without CedarModule through the installing module', async () => {
    let allowed = true;
    const Declared = route('/declared');
    RequireResource({ action: 'read', resourceType: 'Doc' })(Declared);
    class Outside {}
    Module({ controllers: [Declared] })(Outside);
    class App {}
    Module({
      providers: [{ provide: APP_GUARD, useExisting: CedarGuard }],
      imports: [
        CedarModule.forRoot({
          authorize: async ({ identity }) => allowed && identity.principal.subject === 'alice',
        }),
        Outside,
      ],
    })(App);
    const app = await VelaFactory.create(App, {
      middleware: [
        async (c, next) => {
          if (c.req.header('x-auth')) setTrustedRequestIdentity(c.req.raw, { principal });
          await next();
        },
      ],
    });
    try {
      const hono = app.getHonoApp();
      expect((await hono.request('/declared')).status).toBe(403);
      expect((await hono.request('/declared', { headers: { 'x-auth': 'yes' } })).status).toBe(200);
      allowed = false;
      expect((await hono.request('/declared', { headers: { 'x-auth': 'yes' } })).status).toBe(403);
    } finally {
      await app.close();
    }
  });
  it('lets a testing module override the globally installed CedarGuard', async () => {
    const Undeclared = route('/undeclared');
    const imports = [CedarModule.forRoot({ authorize: async () => false })];
    const real = await (
      await Test.createTestingModule({
        imports,
        controllers: [Undeclared],
        providers: [{ provide: APP_GUARD, useExisting: CedarGuard }],
      }).compile()
    ).createApplication();
    expect((await real.getHonoApp().request('/undeclared')).status).toBe(403);
    class AllowAll extends CedarGuard {
      override async canActivate(): Promise<boolean> {
        return true;
      }
    }
    const moduleRef = await Test.createTestingModule({
      imports,
      controllers: [Undeclared],
      providers: [{ provide: APP_GUARD, useExisting: CedarGuard }],
    })
      .overrideGuard(CedarGuard)
      .useValue(new AllowAll(new Reflector()))
      .compile();
    const app = await moduleRef.createApplication();
    expect((await app.getHonoApp().request('/undeclared')).status).toBe(200);
  });
  it('keeps a route-level CedarGuard fail-closed where no CedarModule is visible', async () => {
    const Undeclared = route('/undeclared');
    const Declared = route('/declared');
    RequireResource({ action: 'read', resourceType: 'Doc' })(Declared);
    for (const target of [Undeclared, Declared]) UseGuards(CedarGuard)(target);
    class Feature {}
    Module({ controllers: [Undeclared, Declared] })(Feature);
    class App {}
    Module({
      imports: [CedarModule.forRoot({ undeclared: 'allow', authorize: async () => true }), Feature],
    })(App);
    const app = await VelaFactory.create(App, {
      middleware: [
        async (c, next) => {
          setTrustedRequestIdentity(c.req.raw, { principal });
          await next();
        },
      ],
    });
    try {
      expect((await app.getHonoApp().request('/undeclared')).status).toBe(403);
      expect((await app.getHonoApp().request('/declared')).status).toBe(403);
    } finally {
      await app.close();
    }
  });
});
