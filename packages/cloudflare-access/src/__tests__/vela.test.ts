import type { CanActivate, ExecutionContext } from '@velajs/vela';
import { getAccessRequestIdentity } from '../vela/access-request-state';
import {
  getTrustedRequestIdentity,
  setTrustedRequestIdentity,
  setTrustedRequestTenant,
} from '@velajs/vela/module-kit';
import { ThrottlerModule } from '@velajs/vela/throttler';
import { APP_GUARD, Controller, Get, Module, UseGuards, VelaFactory } from '@velajs/vela';
import {
  AuthzModule,
  PermissionGuard,
  RequirePermission,
  CurrentIdentity,
} from '@velajs/authz/vela';
import { createAuthz, defineRole } from '@velajs/authz';
import { beforeAll, describe, expect, it } from 'vitest';
import { cloudflareAccessIssuer } from '../issuer';
import type { ResolvedIdentity } from '../types';
import type { TrustedRequestIdentity } from '@velajs/vela/module-kit';
import {
  CloudflareAccessGuard,
  CloudflareAccessModule,
  CurrentAccessIdentity,
  identityFromAccess,
} from '../vela';
import { makeKeyMaterial, mintToken, type TestKeyMaterial } from './harness';

const preset = cloudflareAccessIssuer('acme');
const AUD = 'app-audience-tag';

let keys: TestKeyMaterial;
beforeAll(async () => {
  keys = await makeKeyMaterial();
});

const tokenWith = (claims: Record<string, unknown>, subject = 'user-1'): Promise<string> =>
  mintToken({
    privateKey: keys.privateKey,
    kid: keys.kid,
    issuer: preset.issuer,
    audience: AUD,
    subject,
    claims,
  });

const withHeader = (path: string, token?: string): Request =>
  new Request(`http://local.test${path}`, {
    headers: token === undefined ? {} : { [preset.header]: token },
  });

describe('CloudflareAccessGuard', () => {
  it('preserves provider claims through admitted tenant enrichment', async () => {
    class AdmitTenant implements CanActivate {
      canActivate(context: ExecutionContext) {
        const request = context.getRequest();
        setTrustedRequestTenant(request, getTrustedRequestIdentity(request)!, 'tenant-a');
        return true;
      }
    }
    @Controller('/admitted')
    @UseGuards(CloudflareAccessGuard, AdmitTenant)
    class Routes {
      @Get()
      read(
        @CurrentAccessIdentity() payload: ResolvedIdentity | undefined,
        @CurrentIdentity() identity: TrustedRequestIdentity | undefined,
      ) {
        return { email: payload?.email, tenant: identity?.tenantId };
      }
    }
    @Module({
      imports: [CloudflareAccessModule.forRoot({ preset, aud: AUD, keySet: keys.jwks })],
      controllers: [Routes],
    })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const token = await tokenWith({ email: 'ada@example.com' });
      const response = await app.getHonoApp().request(withHeader('/admitted', token));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ email: 'ada@example.com', tenant: 'tenant-a' });
    } finally {
      await app.close();
    }
  });

  it('required mode: publishes one trusted identity and CurrentIdentity reads it', async () => {
    @Controller('/me')
    @UseGuards(CloudflareAccessGuard)
    class MeController {
      @Get()
      me(@CurrentIdentity() identity: TrustedRequestIdentity | undefined) {
        return identity;
      }
    }

    @Module({
      imports: [CloudflareAccessModule.forRoot({ preset, aud: AUD, keySet: keys.jwks })],
      controllers: [MeController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const token = await tokenWith({ email: 'ada@example.com', groups: ['admins'] });
    const res = await app.getHonoApp().request(withHeader('/me', token));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      principal: { issuer: preset.issuer, subject: 'user-1', principalType: 'user' },
      claims: { email: 'ada@example.com', groups: ['admins'] },
      roles: [],
      expiresAtMs: expect.any(Number),
    });

    await app.dispose();
  });

  it('required mode: fails closed with 401 for an anonymous caller', async () => {
    @Controller('/me')
    @UseGuards(CloudflareAccessGuard)
    class MeController {
      @Get()
      me() {
        return { ok: true };
      }
    }

    @Module({
      imports: [CloudflareAccessModule.forRoot({ preset, aud: AUD, keySet: keys.jwks })],
      controllers: [MeController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request(withHeader('/me'));
    expect(res.status).toBe(401);
    await app.dispose();
  });

  it('optional mode: lets an anonymous caller through with no identity', async () => {
    @Controller('/maybe')
    @UseGuards(CloudflareAccessGuard)
    class MaybeController {
      @Get()
      maybe(@CurrentIdentity() identity: TrustedRequestIdentity | undefined) {
        return { hasIdentity: Boolean(identity) };
      }
    }

    @Module({
      imports: [
        CloudflareAccessModule.forRoot({ preset, aud: AUD, keySet: keys.jwks, mode: 'optional' }),
      ],
      controllers: [MaybeController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request(withHeader('/maybe'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasIdentity: false });
    await app.dispose();
  });
});

describe('identityFromAccess', () => {
  it('maps stable principal fields and explicit local roles into authz', async () => {
    const identity: ResolvedIdentity = {
      issuer: preset.issuer,
      subject: 'user-1',
      principalType: 'user',
      expiresAtMs: Date.now() + 60_000,
      groups: ['editor'],
      roles: ['editor'],
      claims: { sub: 'user-1', groups: ['editor'] },
    };
    const mapped = identityFromAccess(identity);
    expect(mapped.subject).toBe('user-1');
    expect(mapped.issuer).toBe(preset.issuer);
    expect(mapped.roles).toEqual(['editor']);
    expect(mapped.claims).toEqual({ sub: 'user-1', groups: ['editor'] });

    const authz = createAuthz({ roles: [defineRole('editor', ['posts:write'])] });
    expect(await authz.can(mapped, 'posts:write')).toBe(true);
    expect(await authz.can(mapped, 'posts:delete')).toBe(false);
  });

  it('does not treat unmapped external groups as local roles', () => {
    const mapped = identityFromAccess({
      issuer: preset.issuer,
      subject: 'svc',
      principalType: 'service',
      expiresAtMs: Date.now() + 60_000,
      groups: ['admin'],
      claims: {},
    });
    expect(mapped.roles).toEqual([]);
  });
});

describe('PermissionGuard', () => {
  it('allows (200) when the mapped identity holds every required permission (AND)', async () => {
    @Controller('/posts')
    @UseGuards(CloudflareAccessGuard, PermissionGuard)
    class PostsController {
      @Get()
      @RequirePermission(['posts:write'])
      write() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthzModule.forRoot({ key: 'primary', roles: [defineRole('editor', ['posts:write'])] }),
        CloudflareAccessModule.forRoot({
          preset,
          aud: AUD,
          keySet: keys.jwks,
          groupRoles: { editor: 'editor' },
        }),
      ],
      controllers: [PostsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const token = await tokenWith({ groups: ['editor'] });
    const res = await app.getHonoApp().request(withHeader('/posts', token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await app.dispose();
  });

  it('denies (403) when a required permission is missing', async () => {
    @Controller('/posts')
    @UseGuards(CloudflareAccessGuard, PermissionGuard)
    class PostsController {
      @Get()
      @RequirePermission(['posts:write'])
      write() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthzModule.forRoot({ key: 'primary', roles: [defineRole('editor', ['posts:write'])] }),
        CloudflareAccessModule.forRoot({ preset, aud: AUD, keySet: keys.jwks }),
      ],
      controllers: [PostsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const token = await tokenWith({ groups: ['viewer'] });
    const res = await app.getHonoApp().request(withHeader('/posts', token));
    expect(res.status).toBe(403);
    await app.dispose();
  });

  it('denies (403) under require-ALL when only some permissions are granted', async () => {
    @Controller('/posts')
    @UseGuards(CloudflareAccessGuard, PermissionGuard)
    class PostsController {
      @Get()
      @RequirePermission(['posts:write', 'posts:delete'])
      write() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthzModule.forRoot({ key: 'primary', roles: [defineRole('editor', ['posts:write'])] }),
        CloudflareAccessModule.forRoot({ preset, aud: AUD, keySet: keys.jwks }),
      ],
      controllers: [PostsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const token = await tokenWith({ groups: ['editor'] });
    const res = await app.getHonoApp().request(withHeader('/posts', token));
    expect(res.status).toBe(403);
    await app.dispose();
  });

  it('fails closed (403) when AuthzModule was never registered (AUTHZ unresolved)', async () => {
    @Controller('/posts')
    @UseGuards(CloudflareAccessGuard, PermissionGuard)
    class PostsController {
      @Get()
      @RequirePermission(['posts:write'])
      write() {
        return { ok: true };
      }
    }

    // No AuthzModule import — AUTHZ is unresolvable, so the guard must deny.
    @Module({
      imports: [CloudflareAccessModule.forRoot({ preset, aud: AUD, keySet: keys.jwks })],
      controllers: [PostsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const token = await tokenWith({ groups: ['editor'] });
    const res = await app.getHonoApp().request(withHeader('/posts', token));
    expect(res.status).toBe(403);
    await app.dispose();
  });

  it('allows (200) when the route declares no required permissions', async () => {
    @Controller('/open')
    @UseGuards(CloudflareAccessGuard, PermissionGuard)
    class OpenController {
      @Get()
      open() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthzModule.forRoot({ key: 'primary', roles: [defineRole('editor', ['posts:write'])] }),
        CloudflareAccessModule.forRoot({ preset, aud: AUD, keySet: keys.jwks }),
      ],
      controllers: [OpenController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const token = await tokenWith({ groups: ['editor'] });
    const res = await app.getHonoApp().request(withHeader('/open', token));
    expect(res.status).toBe(200);
    await app.dispose();
  });

  it('resolves only the AUTHZ provider visible from the declaring route module', async () => {
    @Controller('/scoped')
    @UseGuards(CloudflareAccessGuard, PermissionGuard)
    class ScopedController {
      @Get()
      @RequirePermission(['posts:write'])
      handle() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthzModule.forRoot({ key: 'primary', roles: [defineRole('editor', ['posts:write'])] }),
        CloudflareAccessModule.forRoot({
          preset,
          aud: AUD,
          keySet: keys.jwks,
          groupRoles: { editor: 'editor' },
        }),
      ],
      controllers: [ScopedController],
    })
    class RouteModule {}

    @Module({
      imports: [AuthzModule.forRoot({ roles: [defineRole('editor', ['unrelated:*'])] })],
    })
    class UnrelatedModule {}

    @Module({ imports: [RouteModule, UnrelatedModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const token = await tokenWith({ groups: ['editor'] });
    const res = await app.getHonoApp().request(withHeader('/scoped', token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await app.dispose();
  });

  it('fails closed when more than one AUTHZ provider is registered', async () => {
    @Controller('/ambiguous')
    @UseGuards(CloudflareAccessGuard, PermissionGuard)
    class AmbiguousController {
      @Get()
      @RequirePermission(['posts:write'])
      handle() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthzModule.forRoot({ key: 'primary', roles: [defineRole('editor', ['posts:write'])] }),
        AuthzModule.forRoot({ key: 'secondary', roles: [defineRole('editor', ['posts:*'])] }),
        CloudflareAccessModule.forRoot({
          preset,
          aud: AUD,
          keySet: keys.jwks,
          groupRoles: { editor: 'editor' },
        }),
      ],
      controllers: [AmbiguousController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const token = await tokenWith({ groups: ['editor'] });
    const res = await app.getHonoApp().request(withHeader('/ambiguous', token));
    expect(res.status).toBe(403);
    await app.dispose();
  });
});

describe('shared identity enforcement across Access, authz and core', () => {
  it('Access editor uses the shared permission path with issuer, subject, tenant and expiry', async () => {
    @Controller('/shared')
    @UseGuards(CloudflareAccessGuard, PermissionGuard)
    class SharedController {
      @Get()
      @RequirePermission(['posts:write'])
      read(@CurrentIdentity() identity: TrustedRequestIdentity) {
        return identity;
      }
    }
    @Module({
      imports: [
        CloudflareAccessModule.forRoot({
          preset,
          aud: AUD,
          keySet: keys.jwks,
          groupRoles: { editors: 'editor' },
        }),
        AuthzModule.forRoot({
          resolver: {
            grants(identity) {
              return new Set(
                identity.issuer === preset.issuer &&
                  identity.subject === 'user-1' &&
                  identity.tenantId === 'tenant-a' &&
                  identity.roles?.includes('editor')
                  ? ['posts:write']
                  : [],
              );
            },
          },
        }),
      ],
      controllers: [SharedController],
    })
    class App {}
    const app = await VelaFactory.create(App);
    const token = await tokenWith({ groups: ['editors'], tenantId: 'tenant-a' });
    const request = withHeader('/shared', token);
    const response = await app.getHonoApp().fetch(request);
    expect(response.status).toBe(200);
    const identity = getTrustedRequestIdentity(request);
    expect(identity).toMatchObject({
      principal: { issuer: preset.issuer, subject: 'user-1', principalType: 'user' },
      roles: ['editor'],
      tenantId: 'tenant-a',
      expiresAtMs: expect.any(Number),
    });
    expect(await response.json()).toEqual(identity);
    expect(
      (
        await app
          .getHonoApp()
          .request(
            withHeader('/shared', await tokenWith({ groups: ['editors'], tenantId: 'tenant-b' })),
          )
      ).status,
    ).toBe(403);
    await app.dispose();
  });

  it('rejected, missing and expired credentials clear an old identity even in optional mode', async () => {
    @Controller('/optional')
    @UseGuards(CloudflareAccessGuard)
    class OptionalController {
      @Get() read(@CurrentIdentity() identity: TrustedRequestIdentity | undefined) {
        return { authenticated: Boolean(identity) };
      }
    }
    @Module({
      imports: [
        CloudflareAccessModule.forRoot({ preset, aud: AUD, keySet: keys.jwks, mode: 'optional' }),
      ],
      controllers: [OptionalController],
    })
    class App {}
    const app = await VelaFactory.create(App);
    const expired = await mintToken({
      privateKey: keys.privateKey,
      kid: keys.kid,
      issuer: preset.issuer,
      audience: AUD,
      subject: 'user-1',
      expiresAt: 1,
    });
    for (const token of [undefined, 'invalid-token', expired]) {
      const request = withHeader('/optional', token);
      setTrustedRequestIdentity(request, {
        principal: { issuer: 'stale', subject: 'admin', principalType: 'user' },
        roles: ['admin'],
      });
      const response = await app.getHonoApp().fetch(request);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ authenticated: false });
      expect(getTrustedRequestIdentity(request)).toBeUndefined();
    }
    await app.dispose();
  });

  it('ignores signed role metadata and unmapped external groups', async () => {
    @Controller('/forged')
    @UseGuards(CloudflareAccessGuard, PermissionGuard)
    class ForgedController {
      @Get()
      @RequirePermission(['posts:write'])
      read() {
        return { leaked: true };
      }
    }
    @Module({
      imports: [
        CloudflareAccessModule.forRoot({ preset, aud: AUD, keySet: keys.jwks, mode: 'optional' }),
        AuthzModule.forRoot({ key: 'primary', roles: [defineRole('editor', ['posts:write'])] }),
      ],
      controllers: [ForgedController],
    })
    class App {}
    const app = await VelaFactory.create(App);
    const hono = app.getHonoApp();
    expect(
      (
        await hono.request(
          withHeader('/forged', await tokenWith({ groups: ['editor'], role: 'editor' })),
        )
      ).status,
    ).toBe(403);
    expect((await hono.request(withHeader('/forged'))).status).toBe(403);
    await app.dispose();
  });

  it('core throttling partitions verified Access subjects on a shared client IP', async () => {
    @Module({
      imports: [CloudflareAccessModule.forRoot({ preset, aud: AUD, keySet: keys.jwks })],
      providers: [{ provide: APP_GUARD, useClass: CloudflareAccessGuard }],
    })
    class GlobalAccess {}
    @Controller('/throttle')
    class LimitedController {
      @Get() read() {
        return { ok: true };
      }
    }
    @Module({
      imports: [GlobalAccess, ThrottlerModule.forRoot({ throttlers: [{ limit: 1, ttl: 60_000 }] })],
      controllers: [LimitedController],
    })
    class App {}
    const app = await VelaFactory.create(App, { getClientIp: () => 'same-ip' });
    const first = await tokenWith({ tenantId: 'tenant-a' }, 'user-a');
    const second = await tokenWith({ tenantId: 'tenant-a' }, 'user-b');
    const hono = app.getHonoApp();
    expect((await hono.request(withHeader('/throttle', first))).status).toBe(200);
    expect((await hono.request(withHeader('/throttle', first))).status).toBe(429);
    expect((await hono.request(withHeader('/throttle', second))).status).toBe(200);
    await app.dispose();
  });
});

it('retains mapped Access payload only while its exact core identity is current', async () => {
  const seen: unknown[] = [];
  class InspectPayload implements CanActivate {
    canActivate(context: ExecutionContext) {
      seen.push(getAccessRequestIdentity(context)?.displayLabel);
      setTrustedRequestIdentity(context.getRequest(), {
        principal: { issuer: 'other', subject: 'other', principalType: 'user' },
      });
      seen.push(getAccessRequestIdentity(context));
      return true;
    }
  }
  @Controller('/payload')
  @UseGuards(CloudflareAccessGuard, InspectPayload)
  class PayloadController {
    @Get() read() {
      return { ok: true };
    }
  }
  @Controller('/mapped')
  @UseGuards(CloudflareAccessGuard)
  class MappedController {
    @Get()
    read(@CurrentAccessIdentity() identity: Readonly<ResolvedIdentity>) {
      return { label: identity.displayLabel, subject: identity.subject };
    }
  }
  @Module({
    imports: [
      CloudflareAccessModule.forRoot({
        preset,
        aud: AUD,
        keySet: keys.jwks,
        mapClaims: () => ({ displayLabel: 'Ada' }),
      }),
    ],
    controllers: [PayloadController, MappedController],
  })
  class App {}
  const app = await VelaFactory.create(App);
  expect((await app.getHonoApp().request(withHeader('/payload', await tokenWith({})))).status).toBe(
    200,
  );
  const mapped = await app.getHonoApp().request(withHeader('/mapped', await tokenWith({})));
  expect(mapped.status).toBe(200);
  expect(await mapped.json()).toEqual({ label: 'Ada', subject: 'user-1' });
  expect(seen).toEqual(['Ada', undefined]);
  await app.dispose();
});
