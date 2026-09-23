import { describe, expect, it, vi } from 'vitest';
import {
  APP_GUARD,
  Controller,
  Get,
  Injectable,
  Module,
  Scope,
  UseGuards,
  VelaFactory,
  defineProvider,
  provideGlobal,
  setTrustedRequestIdentity,
} from '@velajs/vela';
import {
  AUTHZ,
  AuthzModule,
  PermissionGuard,
  RolesGuard,
  RequirePermission,
  Roles,
  authorizationAudit,
  type AuthorizationWiringDiagnostic,
} from '../index';
import { createAuthz } from '../../authz';

function route(target: new () => object, path: string) {
  Controller(path)(target);
  Get()(target.prototype, 'read', Object.getOwnPropertyDescriptor(target.prototype, 'read')!);
}

describe('mounted HTTP authorization audit', () => {
  it('rejects metadata without guards or visible engine, without constructing request controllers', async () => {
    const constructed = vi.fn();
    class Routes {
      constructor() {
        constructed();
      }
      read() {
        return 'private';
      }
    }
    route(Routes, '/private');
    Injectable({ scope: Scope.REQUEST })(Routes);
    RequirePermission(['read'])(Routes);
    class App {}
    Module({ controllers: [Routes] })(App);
    const diagnostics: AuthorizationWiringDiagnostic[] = [];
    await expect(
      VelaFactory.create(App, {
        adapters: [
          authorizationAudit({
            onDiagnostic: (d) => diagnostics.push(d),
          }),
        ],
      }),
    ).rejects.toThrow('Routes.read');
    expect(diagnostics.map((d) => d.code)).toEqual([
      'permission-guard-unverified',
      'authz-missing',
    ]);
    expect(constructed).not.toHaveBeenCalled();
  });

  it('accepts inherited requirements and global aliases without constructing the engine', async () => {
    class Base {
      read() {
        return 'private';
      }
    }
    RequirePermission(['read'])(Base);
    class Routes extends Base {}
    Controller('/private')(Routes);
    Get()(Base.prototype, 'read', Object.getOwnPropertyDescriptor(Base.prototype, 'read')!);
    const factory = vi.fn(() => createAuthz({ roles: [] }));
    class App {}
    Module({
      controllers: [Routes],
      providers: [
        defineProvider(AUTHZ, { scope: Scope.REQUEST, useFactory: factory, inject: [] }),
        ...provideGlobal('guard', PermissionGuard),
      ],
    })(App);
    const app = await VelaFactory.create(App, { adapters: [authorizationAudit()] });
    try {
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('verifies request-scoped class guards and scoped aliases without construction', async () => {
    class Routes {
      read() {
        return 'private';
      }
    }
    route(Routes, '/private');
    RequirePermission(['read'])(Routes);
    Roles(['reader'])(Routes);
    class AliasGuard extends RolesGuard {}
    UseGuards(AliasGuard)(Routes);
    const factory = vi.fn(() => createAuthz({ roles: [] }));
    class App {}
    Module({
      controllers: [Routes],
      providers: [
        defineProvider(AUTHZ, { scope: Scope.REQUEST, useFactory: factory, inject: [] }),
        defineProvider(APP_GUARD, { scope: Scope.REQUEST, useClass: PermissionGuard }),
        defineProvider(RolesGuard, { scope: Scope.REQUEST, useClass: RolesGuard }),
        defineProvider(AliasGuard, { scope: Scope.REQUEST, useExisting: RolesGuard }),
      ],
    })(App);
    const app = await VelaFactory.create(App, { adapters: [authorizationAudit()] });
    try {
      const container = app.getContainer();
      const owner = container.getOwnerModuleIds(Routes)[0];
      expect(container.getVisibleProviderSnapshots(RolesGuard, owner)[0]?.instance).toBeUndefined();
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('verifies guards declared on the owning module', async () => {
    class Routes {
      read() {
        return 'private';
      }
    }
    route(Routes, '/private');
    Roles(['reader'])(Routes);
    class App {}
    Module({
      controllers: [Routes],
      providers: [defineProvider(RolesGuard, { scope: Scope.REQUEST, useClass: RolesGuard })],
    })(App);
    UseGuards(RolesGuard)(App);
    const app = await VelaFactory.create(App, { adapters: [authorizationAudit()] });
    try {
      const allowed = new Request('https://test.invalid/private');
      setTrustedRequestIdentity(allowed, {
        principal: { issuer: 'test', subject: 'reader', principalType: 'user' },
        roles: ['reader'],
      });
      const responses = await Promise.all([
        app.getHonoApp().request(allowed),
        app.getHonoApp().request('https://test.invalid/private'),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 403]);
    } finally {
      await app.close();
    }
  });

  it('does not approve a subclass overriding the built-in policy check', async () => {
    class Routes {
      read() {
        return 'private';
      }
    }
    route(Routes, '/private');
    Roles(['reader'])(Routes);
    class CustomGuard extends RolesGuard {
      override canActivate() {
        return true;
      }
    }
    class App {}
    Module({
      controllers: [Routes],
      providers: [defineProvider(APP_GUARD, { useValue: new CustomGuard() })],
    })(App);
    await expect(VelaFactory.create(App, { adapters: [authorizationAudit()] })).rejects.toThrow(
      'Roles has no verifiable RolesGuard',
    );
  });

  it('follows an exported alias to its private owner even when the consumer shadows its target', async () => {
    class Routes {
      read() {
        return 'private';
      }
    }
    route(Routes, '/private');
    Roles(['reader'])(Routes);
    class PublicGuard extends RolesGuard {}
    UseGuards(PublicGuard)(Routes);
    class PolicyModule {}
    Module({
      providers: [
        defineProvider(RolesGuard, { scope: Scope.REQUEST, useClass: RolesGuard }),
        defineProvider(PublicGuard, { scope: Scope.REQUEST, useExisting: RolesGuard }),
      ],
      exports: [PublicGuard],
    })(PolicyModule);
    class CustomGuard extends RolesGuard {
      override canActivate() {
        return true;
      }
    }
    class App {}
    Module({
      imports: [PolicyModule],
      controllers: [Routes],
      providers: [defineProvider(RolesGuard, { useValue: new CustomGuard() })],
    })(App);
    const app = await VelaFactory.create(App, { adapters: [authorizationAudit()] });
    try {
      const container = app.getContainer();
      const owner = container.getOwnerModuleIds(Routes)[0];
      const request = container.createChild();
      try {
        expect(await request.resolveAsync(PublicGuard, owner)).toBeInstanceOf(RolesGuard);
        expect(await request.resolveAsync(PublicGuard, owner)).not.toBeInstanceOf(CustomGuard);
      } finally {
        await request.dispose();
      }
    } finally {
      await app.close();
    }
  });

  it('audits and executes request-scoped APP_GUARD aliases through HTTP', async () => {
    class Routes {
      read() {
        return 'private';
      }
    }
    route(Routes, '/private');
    Roles(['reader'])(Routes);
    class PolicyModule {}
    Module({
      providers: [
        defineProvider(RolesGuard, { scope: Scope.REQUEST, useClass: RolesGuard }),
        defineProvider(APP_GUARD, { scope: Scope.REQUEST, useExisting: RolesGuard }),
      ],
    })(PolicyModule);
    class App {}
    Module({ imports: [PolicyModule], controllers: [Routes] })(App);
    const app = await VelaFactory.create(App, { adapters: [authorizationAudit()] });
    try {
      const allowed = new Request('https://test.invalid/private');
      setTrustedRequestIdentity(allowed, {
        principal: { issuer: 'test', subject: 'reader', principalType: 'user' },
        roles: ['reader'],
      });
      const responses = await Promise.all([
        app.getHonoApp().request(allowed),
        app.getHonoApp().request('https://test.invalid/private'),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 403]);
    } finally {
      await app.close();
    }
  });

  it('warns about opaque request factories without running them', async () => {
    class Routes {
      read() {
        return 'private';
      }
    }
    route(Routes, '/private');
    Roles(['reader'])(Routes);
    const factory = vi.fn(() => new RolesGuard());
    class App {}
    Module({
      controllers: [Routes],
      providers: [
        defineProvider(APP_GUARD, {
          scope: Scope.REQUEST,
          useFactory: factory,
          inject: [],
        }),
      ],
    })(App);
    const diagnostics: AuthorizationWiringDiagnostic[] = [];
    const app = await VelaFactory.create(App, {
      adapters: [
        authorizationAudit({
          mode: 'warn',
          onDiagnostic: (d) => diagnostics.push(d),
        }),
      ],
    });
    try {
      expect(diagnostics.map((d) => d.code)).toEqual(['roles-guard-unverified']);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('uses constructor and owner identity across imported modules, ignoring unused decorated classes', async () => {
    const first = class Routes {
      read() {
        return 'first';
      }
    };
    const second = class Routes {
      read() {
        return 'second';
      }
    };
    class Unused {
      read() {
        return 'unused';
      }
    }
    for (const [target, path] of [
      [first, '/first'],
      [second, '/second'],
      [Unused, '/unused'],
    ] as const) {
      route(target, path);
      RequirePermission(['read'])(target);
    }
    UseGuards(PermissionGuard)(first);
    class FirstModule {}
    Module({ controllers: [first], imports: [AuthzModule.forRoot({ roles: [] })] })(FirstModule);
    class SecondModule {}
    Module({ controllers: [second] })(SecondModule);
    class App {}
    Module({ imports: [FirstModule, SecondModule] })(App);
    const diagnostics: AuthorizationWiringDiagnostic[] = [];
    const app = await VelaFactory.create(App, {
      adapters: [
        authorizationAudit({
          mode: 'warn',
          onDiagnostic: (d) => diagnostics.push(d),
        }),
      ],
    });
    try {
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics.every((d) => d.controller === second)).toBe(true);
      expect(
        diagnostics.every((d) => d.moduleId === app.getContainer().getOwnerModuleIds(second)[0]),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('reports ambiguous module-visible engines and honors empty method overrides', async () => {
    class Routes {
      read() {
        return 'private';
      }
      public() {
        return 'public';
      }
    }
    route(Routes, '/private');
    Get('/public')(
      Routes.prototype,
      'public',
      Object.getOwnPropertyDescriptor(Routes.prototype, 'public')!,
    );
    RequirePermission(['read'])(Routes);
    RequirePermission([])(
      Routes.prototype,
      'public',
      Object.getOwnPropertyDescriptor(Routes.prototype, 'public')!,
    );
    UseGuards(PermissionGuard)(Routes);
    class App {}
    Module({
      controllers: [Routes],
      imports: [
        AuthzModule.forRoot({ key: 'one', roles: [] }),
        AuthzModule.forRoot({ key: 'two', roles: [] }),
      ],
    })(App);
    const diagnostics: AuthorizationWiringDiagnostic[] = [];
    const app = await VelaFactory.create(App, {
      adapters: [
        authorizationAudit({
          mode: 'warn',
          onDiagnostic: (d) => diagnostics.push(d),
        }),
      ],
    });
    try {
      expect(diagnostics.map((d) => [d.code, d.handler])).toEqual([['authz-ambiguous', 'read']]);
    } finally {
      await app.close();
    }
  });

  it('terminates alias-cycle inspection without resolving the guard', async () => {
    class Routes {
      read() {
        return 'private';
      }
    }
    route(Routes, '/private');
    Roles(['reader'])(Routes);
    class AliasA extends RolesGuard {}
    class AliasB extends RolesGuard {}
    UseGuards(AliasA)(Routes);
    class App {}
    Module({
      controllers: [Routes],
      providers: [
        defineProvider(AliasA, { scope: Scope.REQUEST, useExisting: AliasB }),
        defineProvider(AliasB, { scope: Scope.REQUEST, useExisting: AliasA }),
      ],
    })(App);
    const diagnostics: AuthorizationWiringDiagnostic[] = [];
    const app = await VelaFactory.create(App, {
      adapters: [
        authorizationAudit({
          mode: 'warn',
          onDiagnostic: (d) => diagnostics.push(d),
        }),
      ],
    });
    try {
      expect(diagnostics.map((d) => d.code)).toEqual(['roles-guard-unverified']);
    } finally {
      await app.close();
    }
  });

  it('does not treat a missing alias target as an unregistered direct guard', async () => {
    class Routes {
      read() {
        return 'private';
      }
    }
    route(Routes, '/private');
    Roles(['reader'])(Routes);
    class Alias extends RolesGuard {}
    UseGuards(Alias)(Routes);
    class App {}
    Module({
      controllers: [Routes],
      providers: [defineProvider(Alias, { scope: Scope.REQUEST, useExisting: RolesGuard })],
    })(App);
    await expect(VelaFactory.create(App, { adapters: [authorizationAudit()] })).rejects.toThrow(
      'Roles has no verifiable RolesGuard',
    );
  });
});
