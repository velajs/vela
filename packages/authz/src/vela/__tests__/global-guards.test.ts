import { describe, expect, it } from 'vitest';
import {
  APP_GUARD,
  Controller,
  Get,
  Injectable,
  Module,
  VelaFactory,
  defineProvider,
  type CanActivate,
  type ExecutionContext,
  type GuardPhase,
} from '@velajs/vela';
import { setTrustedRequestIdentity } from '@velajs/vela/module-kit';
import { defineRole } from '../../index';
import { AuthzModule, PermissionGuard, RequirePermission, Roles, RolesGuard } from '../index';

// A stand-in authentication integration: it publishes identity from a header.
class HeaderAuthentication implements CanActivate {
  static readonly phase: GuardPhase = 'authenticate';
  canActivate(context: ExecutionContext): boolean {
    const role = context.getRequest().headers.get('x-role');
    if (role) {
      setTrustedRequestIdentity(context.getRequest(), {
        principal: { issuer: 'tests', subject: 'u-1', principalType: 'user' },
        roles: [role],
      });
    }
    return true;
  }
}
Injectable()(HeaderAuthentication);

class Posts {
  write() {
    return { ok: true };
  }
  review() {
    return { ok: true };
  }
}
Controller('/posts')(Posts);
Get('/write')(Posts.prototype, 'write', Object.getOwnPropertyDescriptor(Posts.prototype, 'write')!);
Get('/review')(
  Posts.prototype,
  'review',
  Object.getOwnPropertyDescriptor(Posts.prototype, 'review')!,
);
RequirePermission(['posts:write'])(
  Posts.prototype,
  'write',
  Object.getOwnPropertyDescriptor(Posts.prototype, 'write')!,
);
Roles(['reviewer'])(
  Posts.prototype,
  'review',
  Object.getOwnPropertyDescriptor(Posts.prototype, 'review')!,
);

async function application(guard?: 'global' | 'none') {
  class App {}
  Module({
    // Authorization is imported first; its guards still run after authentication.
    imports: [
      AuthzModule.forRoot({
        roles: [defineRole('editor', ['posts:write'])],
        ...(guard === undefined ? {} : { guard }),
      }),
    ],
    controllers: [Posts],
    providers: [
      HeaderAuthentication,
      defineProvider(APP_GUARD, { useExisting: HeaderAuthentication }),
    ],
  })(App);
  return VelaFactory.create(App);
}

describe('AuthzModule global guards', () => {
  it('installs PermissionGuard and RolesGuard in the authorize phase by default', async () => {
    expect(PermissionGuard.phase).toBe('authorize');
    expect(RolesGuard.phase).toBe('authorize');
    const app = await application();
    const hono = app.getHonoApp();
    try {
      expect((await hono.request('/posts/write')).status).toBe(403);
      expect((await hono.request('/posts/write', { headers: { 'x-role': 'editor' } })).status).toBe(
        200,
      );
      expect(
        (await hono.request('/posts/review', { headers: { 'x-role': 'editor' } })).status,
      ).toBe(403);
      expect(
        (await hono.request('/posts/review', { headers: { 'x-role': 'reviewer' } })).status,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("leaves routes to explicit guards with guard: 'none'", async () => {
    const app = await application('none');
    try {
      expect((await app.getHonoApp().request('/posts/write')).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
