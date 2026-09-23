import { describe, expect, it, vi } from 'vitest';
import { Controller, Get, Module, Reflector, VelaFactory } from '@velajs/vela';
import { setTrustedRequestIdentity, clearTrustedRequestIdentity } from '@velajs/vela/module-kit';
import { auditCedarRoutes, CedarModule, CedarPublic, RequireResource } from '../vela/index';
const principal = { issuer: 'test', subject: 'alice', principalType: 'user' } as const;
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
});
