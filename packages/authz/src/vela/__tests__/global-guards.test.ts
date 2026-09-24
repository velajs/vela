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
  type DynamicModule,
  type ExecutionContext,
  type GuardPhase,
  type VelaApplication,
} from '@velajs/vela';
import { orderGuardsByPhase, setTrustedRequestIdentity } from '@velajs/vela/module-kit';
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

const editor = defineRole('editor', ['posts:write']);

async function application(
  authz: DynamicModule = AuthzModule.forRoot({ roles: [editor] }),
): Promise<VelaApplication> {
  class App {}
  Module({
    // Authorization is imported first; its guards still run after authentication.
    imports: [authz],
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
    // Integration routes that authorize themselves (SkipGuardPhases) skip them.
    expect(PermissionGuard.skippable).toBe(true);
    expect(RolesGuard.skippable).toBe(true);
    // An application subclass redeclares it to run on those routes too.
    class StrictPermissionGuard extends PermissionGuard {
      static override readonly skippable = false;
    }
    class StrictRolesGuard extends RolesGuard {
      static override readonly skippable = false;
    }
    const guards = [PermissionGuard, StrictPermissionGuard, RolesGuard, StrictRolesGuard];
    expect(orderGuardsByPhase(guards, new Set<GuardPhase>(['authorize']))).toEqual([
      StrictPermissionGuard,
      StrictRolesGuard,
    ]);
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
    const app = await application(AuthzModule.forRoot({ roles: [editor], guard: 'none' }));
    try {
      expect((await app.getHonoApp().request('/posts/write')).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('takes guard beside a forRootAsync factory, defaulting to one global install', async () => {
    // A spelled-out default is the same instance as leaving it out.
    expect(AuthzModule.forRoot({ roles: [editor], guard: 'global' }).key).toBe(
      AuthzModule.forRoot({ roles: [editor] }).key,
    );
    const statuses: number[] = [];
    for (const guard of ['global', 'none'] as const) {
      const app = await application(
        AuthzModule.forRootAsync({ guard, useFactory: () => ({ roles: [editor] }) }),
      );
      try {
        statuses.push((await app.getHonoApp().request('/posts/write')).status);
      } finally {
        await app.close();
      }
    }
    expect(statuses).toEqual([403, 200]);
  });

  it('serves each module its own engine from one global install under distinct keys', async () => {
    class Drafts {
      write() {
        return { ok: true };
      }
    }
    Controller('/drafts')(Drafts);
    const write = Object.getOwnPropertyDescriptor(Drafts.prototype, 'write')!;
    Get('/write')(Drafts.prototype, 'write', write);
    RequirePermission(['posts:write'])(Drafts.prototype, 'write', write);
    // Editors write posts but not drafts.
    const feature = (controller: typeof Posts | typeof Drafts, authz: DynamicModule) => {
      class Feature {}
      Module({ imports: [authz], controllers: [controller] })(Feature);
      return Feature;
    };
    const build = (posts: DynamicModule, drafts: DynamicModule) => {
      class App {}
      Module({
        imports: [feature(Posts, posts), feature(Drafts, drafts)],
        providers: [
          HeaderAuthentication,
          defineProvider(APP_GUARD, { useExisting: HeaderAuthentication }),
        ],
      })(App);
      return VelaFactory.create(App);
    };
    const draftEditor = defineRole('editor', []);
    // Two engines under one instance key are two configurations of one instance.
    await expect(
      build(
        AuthzModule.forRoot({ roles: [editor], guard: 'none' }),
        AuthzModule.forRoot({ roles: [draftEditor], guard: 'none' }),
      ),
    ).rejects.toThrow(/imported again with different options/);
    const app = await build(
      AuthzModule.forRoot({ key: 'posts', roles: [editor] }),
      AuthzModule.forRoot({ key: 'drafts', roles: [draftEditor], guard: 'none' }),
    );
    try {
      const hono = app.getHonoApp();
      const headers = { 'x-role': 'editor' };
      expect((await hono.request('/posts/write', { headers })).status).toBe(200);
      expect((await hono.request('/drafts/write', { headers })).status).toBe(403);
    } finally {
      await app.close();
    }
  });
});
