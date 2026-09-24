import { describe, expect, it, vi } from 'vitest';
import { Controller, Get, Inject, Module, Reflector, UseGuards, VelaFactory } from '@velajs/vela';
import { setTrustedRequestIdentity, clearTrustedRequestIdentity } from '@velajs/vela/module-kit';
import { MemoryTenantRegistryStore, TenantRegistry, type TenantContextReader } from '../index';
import {
  TenantModule,
  TenantGuard,
  TenantOptional,
  TenantIgnored,
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

describe('Vela tenant admission', () => {
  it('reads route requirements through the application Reflector', async () => {
    class Routes {
      open() {
        return { public: true };
      }
    }
    Controller('/open')(Routes);
    UseGuards(TenantGuard)(Routes);
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
    UseGuards(TenantGuard)(Routes);
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
  it('does not publish authority if authentication is cleared during admission', async () => {
    let activeRequest: Request | undefined;
    class Routes {
      handle() {
        return 'never';
      }
    }
    Controller('/changed')(Routes);
    Get()(Routes.prototype, 'handle', Object.getOwnPropertyDescriptor(Routes.prototype, 'handle')!);
    UseGuards(TenantGuard)(Routes);
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
