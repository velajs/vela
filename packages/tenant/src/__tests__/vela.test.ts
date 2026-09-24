import { describe, expect, it, vi } from 'vitest';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Reflector,
  Req,
  UseGuards,
  VelaFactory,
  type GuardPhase,
} from '@velajs/vela';
import {
  setTrustedRequestIdentity,
  clearTrustedRequestIdentity,
  getTrustedRequestIdentity,
  orderGuardsByPhase,
  SkipGuardPhases,
} from '@velajs/vela/module-kit';
import { Test } from '@velajs/testing';
import { MemoryTenantRegistryStore, TenantRegistry, type TenantContextReader } from '../index';
import {
  TenantModule,
  TenantGuard,
  TenantOptional,
  TenantIgnored,
  TenantRequired,
  TENANT_CONTEXT_READER,
  runInTenantScope,
} from '../vela/index';
const principal = { issuer: 'test', subject: 'alice', principalType: 'user' } as const;
const tenant = (id: string) => ({
  id,
  name: id,
  status: 'active' as const,
  revision: 1,
  settings: {},
});
const reply = (value: string) =>
  class {
    handle() {
      return value;
    }
  };
const route = (target: new () => object, path: string) => {
  Controller(path)(target);
  Get()(target.prototype, 'handle', Object.getOwnPropertyDescriptor(target.prototype, 'handle')!);
  return target;
};

describe('Vela tenant admission', () => {
  it('reads route requirements through the application Reflector', async () => {
    class Routes {
      open() {
        return { public: true };
      }
    }
    Controller('/open')(Routes);
    const open = Object.getOwnPropertyDescriptor(Routes.prototype, 'open')!;
    Get()(Routes.prototype, 'open', open);
    TenantIgnored()(Routes.prototype, 'open', open);
    class App {}
    Module({
      imports: [
        TenantModule.forRoot({ lookup: new MemoryTenantRegistryStore([]), authorize: () => false }),
      ],
      controllers: [Routes],
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

  it('isolates HTTP requests, rejects forged/conflicting selectors, and observes suspension', async () => {
    const store = new MemoryTenantRegistryStore([tenant('a'), tenant('b')]);
    let retained: TenantContextReader | undefined;
    class Routes {
      constructor(readonly context: TenantContextReader) {}
      handle() {
        retained = this.context;
        return { tenant: this.context.requireTenantId() };
      }
      optional() {
        return { tenant: this.context.current()?.id ?? null };
      }
      ignored() {
        return { public: true };
      }
    }
    Inject(TENANT_CONTEXT_READER)(Routes, undefined, 0);
    Controller('/tenants')(Routes);
    for (const name of ['handle', 'optional', 'ignored'] as const)
      Get(`/${name}`)(
        Routes.prototype,
        name,
        Object.getOwnPropertyDescriptor(Routes.prototype, name)!,
      );
    TenantOptional()(
      Routes.prototype,
      'optional',
      Object.getOwnPropertyDescriptor(Routes.prototype, 'optional')!,
    );
    TenantIgnored()(
      Routes.prototype,
      'ignored',
      Object.getOwnPropertyDescriptor(Routes.prototype, 'ignored')!,
    );
    class App {}
    Module({
      imports: [
        TenantModule.forRoot({
          lookup: store,
          authorize: ({ principal }) => principal.subject === 'alice',
        }),
      ],
      controllers: [Routes],
    })(App);
    const app = await VelaFactory.create(App, {
      middleware: [
        async (c, next) => {
          if (c.req.header('x-auth') === 'yes')
            setTrustedRequestIdentity(c.req.raw, {
              principal,
              ...(c.req.header('x-bound') ? { tenantId: c.req.header('x-bound')! } : {}),
            });
          await next();
        },
      ],
    });
    try {
      const responses = await Promise.all(
        ['a', 'b'].map((id) =>
          app
            .getHonoApp()
            .request('/tenants/handle', { headers: { 'x-auth': 'yes', 'x-tenant-id': id } }),
        ),
      );
      expect(await Promise.all(responses.map((r) => r.json()))).toEqual([
        { tenant: 'a' },
        { tenant: 'b' },
      ]);
      await Promise.resolve();
      expect(() => retained!.requireTenantId()).toThrow();
      expect(
        (await app.getHonoApp().request('/tenants/handle', { headers: { 'x-tenant-id': 'a' } }))
          .status,
      ).toBe(403);
      expect(
        (
          await app.getHonoApp().request('/tenants/handle', {
            headers: { 'x-auth': 'yes', 'x-bound': 'a', 'x-tenant-id': 'b' },
          })
        ).status,
      ).toBe(403);
      expect((await app.getHonoApp().request('/tenants/optional')).status).toBe(200);
      expect(
        (await app.getHonoApp().request('/tenants/optional', { headers: { 'x-tenant-id': 'a' } }))
          .status,
      ).toBe(403);
      expect((await app.getHonoApp().request('/tenants/ignored')).status).toBe(200);
      await new TenantRegistry({ store, authorize: () => true }).save(
        { ...tenant('a'), status: 'suspended' },
        1,
        principal,
        'Suspend',
      );
      expect(
        (
          await app
            .getHonoApp()
            .request('/tenants/handle', { headers: { 'x-auth': 'yes', 'x-tenant-id': 'a' } })
        ).status,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
  it('creates disposable queue, scheduled and WebSocket operation scopes without HTTP context', async () => {
    class App {}
    Module({
      imports: [
        TenantModule.forRoot({
          lookup: new MemoryTenantRegistryStore([tenant('a'), tenant('b')]),
          authorize: () => true,
        }),
      ],
    })(App);
    const app = await VelaFactory.create(App);
    const readers: TenantContextReader[] = [];
    try {
      const ids = await Promise.all(
        ['queue', 'scheduled', 'websocket'].map((source, index) =>
          runInTenantScope(
            app.getContainer(),
            { tenantId: index === 1 ? 'b' : 'a', principal, source },
            async (scope, reader) => {
              readers.push(reader);
              await Promise.resolve();
              expect(scope.resolve(TENANT_CONTEXT_READER)).toBe(reader);
              return reader.requireTenantId();
            },
          ),
        ),
      );
      expect(ids).toEqual(['a', 'b', 'a']);
      for (const reader of readers) expect(() => reader.requireTenantId()).toThrow();
      await expect(
        runInTenantScope(app.getContainer(), { tenantId: 'forged', principal }, () => {}),
      ).rejects.toThrow();
    } finally {
      await app.close();
    }
  });
  it('admits tenants from the global guard on every application route', async () => {
    expect(TenantGuard.phase).toBe('tenant');
    // An application subclass redeclares `skippable` to run on integration routes too.
    class StrictTenantGuard extends TenantGuard {
      static override readonly skippable = false;
    }
    expect(
      orderGuardsByPhase([TenantGuard, StrictTenantGuard], new Set<GuardPhase>(['tenant'])),
    ).toEqual([StrictTenantGuard]);
    const Tenanted = route(reply('tenanted'), '/tenanted');
    const Elsewhere = route(reply('elsewhere'), '/elsewhere');
    const Declared = route(reply('declared'), '/declared');
    TenantRequired()(Declared);
    // An integration's own controller leaves tenant admission to the integration.
    const Integration = route(reply('integration'), '/integration');
    SkipGuardPhases(['tenant'])(Integration);
    class Outside {}
    Module({ controllers: [Elsewhere, Declared, Integration] })(Outside);
    const build = (options: { guard?: 'global' | 'none'; isGlobal?: boolean }) => {
      class App {}
      Module({
        imports: [
          TenantModule.forRoot({
            lookup: new MemoryTenantRegistryStore([tenant('a')]),
            authorize: () => true,
            ...options,
          }),
          Outside,
        ],
        controllers: [Tenanted],
      })(App);
      return VelaFactory.create(App);
    };
    // Whether or not every module can see TenantModule, the phase covers the same routes.
    for (const options of [{}, { isGlobal: true }]) {
      const app = await build(options);
      try {
        const hono = app.getHonoApp();
        for (const path of ['/tenanted', '/elsewhere', '/declared'])
          expect((await hono.request(path)).status).toBe(400);
        expect((await hono.request('/integration')).status).toBe(200);
      } finally {
        await app.close();
      }
    }
    const opted = await build({ guard: 'none' });
    try {
      expect((await opted.getHonoApp().request('/tenanted')).status).toBe(200);
      expect((await opted.getHonoApp().request('/elsewhere')).status).toBe(200);
    } finally {
      await opted.close();
    }
  });

  it('takes guard beside a forRootAsync factory, defaulting to one global install', async () => {
    const options = () => ({
      lookup: new MemoryTenantRegistryStore([tenant('a')]),
      authorize: () => true,
    });
    // A spelled-out default is the same instance as leaving it out.
    const configured = options();
    expect(TenantModule.forRoot({ ...configured, guard: 'global' }).key).toBe(
      TenantModule.forRoot(configured).key,
    );
    const Tenanted = route(reply('tenanted'), '/tenanted');
    const statuses: number[] = [];
    for (const guard of [undefined, 'global', 'none'] as const) {
      class App {}
      Module({
        imports: [TenantModule.forRootAsync({ ...(guard ? { guard } : {}), useFactory: options })],
        controllers: [Tenanted],
      })(App);
      const app = await VelaFactory.create(App);
      try {
        statuses.push((await app.getHonoApp().request('/tenanted')).status);
      } finally {
        await app.close();
      }
    }
    expect(statuses).toEqual([400, 400, 200]);
  });

  it('admits the tenant for routes in modules that do not import TenantModule', async () => {
    const tenancy = TenantModule.forRoot({
      lookup: new MemoryTenantRegistryStore([tenant('a'), tenant('b')]),
      authorize: ({ principal, tenant }) => principal.subject === 'alice' && tenant.id === 'a',
    });
    // A provider that can see TenantModule reads the tenant the global guard admitted.
    class TenantEcho {
      constructor(readonly context: TenantContextReader) {}
    }
    Inject(TENANT_CONTEXT_READER)(TenantEcho, undefined, 0);
    Injectable()(TenantEcho);
    class Shared {}
    Module({ imports: [tenancy], providers: [TenantEcho], exports: [TenantEcho] })(Shared);
    class Routes {
      constructor(readonly echo: TenantEcho) {}
      handle(request: Request) {
        return {
          bound: getTrustedRequestIdentity(request)?.tenantId ?? null,
          scoped: this.echo.context.requireTenantId(),
        };
      }
    }
    Inject(TenantEcho)(Routes, undefined, 0);
    Controller('/feature')(Routes);
    Get()(Routes.prototype, 'handle', Object.getOwnPropertyDescriptor(Routes.prototype, 'handle')!);
    Req()(Routes.prototype, 'handle', 0);
    class Feature {}
    Module({ imports: [Shared], controllers: [Routes] })(Feature);
    class App {}
    Module({ imports: [tenancy, Feature] })(App);
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
      const admitted = await hono.request('/feature', {
        headers: { 'x-auth': 'yes', 'x-tenant-id': 'a' },
      });
      expect(await admitted.json()).toEqual({ bound: 'a', scoped: 'a' });
      expect(
        (await hono.request('/feature', { headers: { 'x-auth': 'yes', 'x-tenant-id': 'b' } }))
          .status,
      ).toBe(403);
      expect((await hono.request('/feature', { headers: { 'x-tenant-id': 'a' } })).status).toBe(
        403,
      );
      expect((await hono.request('/feature')).status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('lets a testing module override the globally installed TenantGuard', async () => {
    const Tenanted = route(reply('tenanted'), '/tenanted');
    const imports = [
      TenantModule.forRoot({ lookup: new MemoryTenantRegistryStore([]), authorize: () => false }),
    ];
    const real = await (
      await Test.createTestingModule({ imports, controllers: [Tenanted] }).compile()
    ).createApplication();
    expect((await real.getHonoApp().request('/tenanted')).status).toBe(400);
    class AllowAll extends TenantGuard {
      override async canActivate(): Promise<boolean> {
        return true;
      }
    }
    const moduleRef = await Test.createTestingModule({ imports, controllers: [Tenanted] })
      .overrideGuard(TenantGuard)
      .useValue(new AllowAll(new Reflector()))
      .compile();
    const app = await moduleRef.createApplication();
    expect((await app.getHonoApp().request('/tenanted')).status).toBe(200);
  });

  it('keeps a route-level TenantGuard fail-closed where no TenantModule is visible', async () => {
    const Orders = route(reply('unscoped'), '/orders');
    UseGuards(TenantGuard)(Orders);
    class OrdersModule {}
    Module({ controllers: [Orders] })(OrdersModule);
    class App {}
    Module({
      imports: [
        TenantModule.forRoot({
          guard: 'none',
          lookup: new MemoryTenantRegistryStore([tenant('a')]),
          authorize: () => true,
        }),
        OrdersModule,
      ],
    })(App);
    const app = await VelaFactory.create(App);
    try {
      const response = await app.getHonoApp().request('/orders');
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: { code: 'forbidden', message: 'Tenant configuration is ambiguous' },
      });
    } finally {
      await app.close();
    }
  });

  it('does not publish authority if authentication is cleared during admission', async () => {
    let activeRequest: Request | undefined;
    class Routes {
      handle() {
        return 'never';
      }
    }
    Controller('/changed')(Routes);
    Get()(Routes.prototype, 'handle', Object.getOwnPropertyDescriptor(Routes.prototype, 'handle')!);
    class App {}
    Module({
      controllers: [Routes],
      imports: [
        TenantModule.forRoot({
          lookup: new MemoryTenantRegistryStore([tenant('a')]),
          authorize: () => {
            clearTrustedRequestIdentity(activeRequest!);
            return true;
          },
        }),
      ],
    })(App);
    const app = await VelaFactory.create(App, {
      middleware: [
        async (c, next) => {
          activeRequest = c.req.raw;
          setTrustedRequestIdentity(c.req.raw, { principal, tenantId: 'a' });
          await next();
        },
      ],
    });
    try {
      expect((await app.getHonoApp().request('/changed')).status).toBe(403);
    } finally {
      await app.close();
    }
  });
});
