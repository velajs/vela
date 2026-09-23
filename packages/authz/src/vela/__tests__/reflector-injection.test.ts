import { describe, expect, it, vi } from 'vitest';
import { Controller, Get, Module, Reflector, UseGuards, VelaFactory } from '@velajs/vela';
import { createAuthz } from '../../authz';
import { AUTHZ, PermissionGuard, RequirePermission, Roles, RolesGuard } from '../index';

function route(target: new () => object, path: string) {
  Controller(path)(target);
  Get()(target.prototype, 'read', Object.getOwnPropertyDescriptor(target.prototype, 'read')!);
}

describe('built-in authorization guards', () => {
  it('read route metadata through the application Reflector', async () => {
    class Routes {
      read() {
        return 'private';
      }
    }
    route(Routes, '/private');
    Roles(['reader'])(Routes);
    RequirePermission(['read'])(Routes);
    UseGuards(RolesGuard, PermissionGuard)(Routes);
    class App {}
    Module({
      controllers: [Routes],
      providers: [{ provide: AUTHZ, useValue: createAuthz({ roles: [] }) }],
    })(App);

    const app = await VelaFactory.create(App);
    try {
      const reads = vi.spyOn(app.get(Reflector), 'getAllAndOverride');
      expect((await app.getHonoApp().request('/private')).status).toBe(403);
      expect(reads).toHaveBeenCalledWith(Roles, expect.anything());
    } finally {
      await app.close();
    }
  });

  it('take the Reflector as their constructor dependency', () => {
    const reflector = new Reflector();
    expect(new RolesGuard(reflector)).toBeInstanceOf(RolesGuard);
    expect(new PermissionGuard(reflector)).toBeInstanceOf(PermissionGuard);
  });
});
