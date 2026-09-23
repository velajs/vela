import { describe, expect, it } from 'vitest';
import { Module, VelaFactory } from '@velajs/vela';
import { definePermission, defineRole } from '../../roles';
import { AUTHZ, AuthzModule } from '../index';

describe('AuthzModule.forRoot', () => {
  it('provides an Authz instance resolvable by the AUTHZ token', async () => {
    // `@velajs/authz` core is intentionally decorator-free, so this package's
    // test tooling does not enable decorator syntax. `@Module` is a plain
    // call-time registration (no metadata emission), so we apply it imperatively
    // — equivalent to `@Module({ ... }) class AppModule {}`.
    class AppModule {}
    Module({
      imports: [AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] })],
    })(AppModule);

    const app = await VelaFactory.create(AppModule);
    const authz = app.get(AUTHZ);

    expect(await authz.can({ roles: ['editor'] }, 'posts:write')).toBe(true);
    expect(await authz.can({ roles: [] }, 'posts:write')).toBe(false);

    await app.dispose();
  });

  it('provides the options bag under a distinct AUTHZ_OPTIONS token', async () => {
    const { AUTHZ_OPTIONS } = await import('../index');

    class AppModule {}
    Module({
      imports: [AuthzModule.forRoot({ roles: [defineRole('viewer', ['posts:read'])] })],
    })(AppModule);

    const app = await VelaFactory.create(AppModule);
    const authz = app.get(AUTHZ);

    // AUTHZ and AUTHZ_OPTIONS are two different tokens for two different values.
    expect(AUTHZ).not.toBe(AUTHZ_OPTIONS);
    expect(await authz.can({ roles: ['viewer'] }, 'posts:read')).toBe(true);
    expect(await authz.can({ roles: ['viewer'] }, 'posts:write')).toBe(false);

    await app.dispose();
  });
});

describe('AuthzModule.forRootAsync', () => {
  it('builds authorization from roles and permissions returned by the async factory', async () => {
    class AppModule {}
    Module({
      imports: [
        AuthzModule.forRootAsync({
          inject: [],
          useFactory: async () => ({
            roles: [defineRole('editor', ['posts:write'])],
            permissions: [definePermission('posts:write')],
          }),
        }),
      ],
    })(AppModule);

    const app = await VelaFactory.create(AppModule);
    try {
      const authz = app.get(AUTHZ);
      expect(await authz.can({ roles: ['editor'] }, 'posts:write')).toBe(true);
      expect(await authz.can({ roles: ['editor'] }, 'posts:delete')).toBe(false);
      expect(await authz.can({ roles: [] }, 'posts:write')).toBe(false);
    } finally {
      await app.dispose();
    }
  });

  it('rejects undeclared role permissions returned by the async factory', async () => {
    class AppModule {}
    Module({
      imports: [
        AuthzModule.forRootAsync({
          inject: [],
          useFactory: async () => ({
            roles: [defineRole('editor', ['posts:write'])],
            permissions: [definePermission('posts:read')],
          }),
        }),
      ],
    })(AppModule);

    await expect(VelaFactory.create(AppModule, { diagnostics: 'throw' })).rejects.toThrow(
      "undeclared permission 'posts:write'",
    );
  });
});
