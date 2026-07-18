import {
  Controller,
  createParamDecorator,
  type ExecutionContext,
  Get,
  MetadataRegistry,
  Module,
  REQUEST_CONTEXT,
  type RequestContext,
  UseGuards,
  VelaFactory,
} from '@velajs/vela';
import { AuthzModule } from '@velajs/authz/vela';
import { createAuthz, defineRole } from '@velajs/authz';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cloudflareAccessIssuer } from '../issuer';
import type { ResolvedIdentity } from '../types';
import {
  AccessPermissionGuard,
  ACCESS_EXP_KEY,
  BETTER_AUTH_ISSUER_KEY,
  BETTER_AUTH_USER_KEY,
  CloudflareAccessGuard,
  CloudflareAccessModule,
  CurrentAccessIdentity,
  identityFromAccess,
  RequireAccessPermission,
} from '../vela';
import { makeKeyMaterial, mintToken, type TestKeyMaterial } from './harness';

const preset = cloudflareAccessIssuer('acme');
const AUD = 'app-audience-tag';

let keys: TestKeyMaterial;
beforeAll(async () => {
  keys = await makeKeyMaterial();
});

beforeEach(() => MetadataRegistry.clear());
afterEach(() => MetadataRegistry.clear());

interface ContainerLike {
  resolve<T>(token: unknown): T;
}

/** Reads the guard-written expiry off the request context (proves ACCESS_EXP_KEY). */
const AccessExp = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  ctx
    .getContext<{ get(key: 'container'): ContainerLike }>()
    .get('container')
    .resolve<RequestContext>(REQUEST_CONTEXT)
    .get<number>(ACCESS_EXP_KEY),
);

/** Reads the Hono `userId` variable the guard sets (the key CF WS routing forwards). */
const HonoUserId = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  ctx.getContext<{ get(key: string): unknown }>().get('userId'),
);

/** Reads the opt-in better-auth interop projection. */
const InteropUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  ctx
    .getContext<{ get(key: 'container'): ContainerLike }>()
    .get('container')
    .resolve<RequestContext>(REQUEST_CONTEXT)
    .get<{ id: string; role: string[] }>(BETTER_AUTH_USER_KEY),
);

const InteropIssuer = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  ctx
    .getContext<{ get(key: 'container'): ContainerLike }>()
    .get('container')
    .resolve<RequestContext>(REQUEST_CONTEXT)
    .get<string>(BETTER_AUTH_ISSUER_KEY),
);

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
  it('required mode: verifies, stashes the identity + exp + userId, and CurrentAccessIdentity reads it', async () => {
    @Controller('/me')
    @UseGuards(CloudflareAccessGuard)
    class MeController {
      @Get()
      me(
        @CurrentAccessIdentity() identity: ResolvedIdentity | undefined,
        @AccessExp() expiresAtMs: number | undefined,
        @HonoUserId() honoUserId: unknown,
      ) {
        return {
          userId: identity?.userId,
          email: identity?.email,
          groups: identity?.groups,
          expiresAtMs,
          honoUserId,
        };
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
    const body = (await res.json()) as {
      userId: string;
      email: string;
      groups: string[];
      expiresAtMs: number;
      honoUserId: string;
    };
    expect(body.userId).toBe('user-1');
    expect(body.email).toBe('ada@example.com');
    expect(body.groups).toEqual(['admins']);
    expect(Number.isSafeInteger(body.expiresAtMs)).toBe(true);
    expect(body.honoUserId).toBe('user-1');

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
      maybe(@CurrentAccessIdentity() identity: ResolvedIdentity | undefined) {
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

  it('opt-in interop: projects {id, role} under the better-auth user key when enabled', async () => {
    @Controller('/interop')
    @UseGuards(CloudflareAccessGuard)
    class InteropController {
      @Get()
      interop(
        @InteropUser() user: { id: string; role: string[] } | undefined,
        @InteropIssuer() issuer: string | undefined,
      ) {
        return { id: user?.id, role: user?.role, issuer };
      }
    }

    @Module({
      imports: [
        CloudflareAccessModule.forRoot({
          preset,
          aud: AUD,
          keySet: keys.jwks,
          betterAuthInterop: true,
          groupRoles: { editor: 'editor' },
        }),
      ],
      controllers: [InteropController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const token = await tokenWith({ groups: ['editor'] });
    const res = await app.getHonoApp().request(withHeader('/interop', token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 'user-1',
      role: ['editor'],
      issuer: preset.issuer,
    });
    await app.dispose();
  });
});

describe('identityFromAccess', () => {
  it('maps stable principal fields and explicit local roles into authz', async () => {
    const identity: ResolvedIdentity = {
      issuer: preset.issuer,
      subject: 'user-1',
      principalType: 'user',
      userId: 'user-1',
      expiresAtMs: Date.now() + 60_000,
      groups: ['editor'],
      roles: ['editor'],
      claims: { sub: 'user-1', groups: ['editor'] },
    };
    const mapped = identityFromAccess(identity);
    expect(mapped.userId).toBe('user-1');
    expect((mapped as { issuer?: string }).issuer).toBe(preset.issuer);
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
      userId: 'svc',
      expiresAtMs: Date.now() + 60_000,
      groups: ['admin'],
      claims: {},
    });
    expect(mapped.roles).toEqual([]);
  });
});

describe('AccessPermissionGuard', () => {
  it('allows (200) when the mapped identity holds every required permission (AND)', async () => {
    @Controller('/posts')
    @UseGuards(CloudflareAccessGuard, AccessPermissionGuard)
    class PostsController {
      @Get()
      @RequireAccessPermission(['posts:write'])
      write() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] }),
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
    @UseGuards(CloudflareAccessGuard, AccessPermissionGuard)
    class PostsController {
      @Get()
      @RequireAccessPermission(['posts:write'])
      write() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] }),
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
    @UseGuards(CloudflareAccessGuard, AccessPermissionGuard)
    class PostsController {
      @Get()
      @RequireAccessPermission(['posts:write', 'posts:delete'])
      write() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] }),
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
    @UseGuards(CloudflareAccessGuard, AccessPermissionGuard)
    class PostsController {
      @Get()
      @RequireAccessPermission(['posts:write'])
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
    @UseGuards(CloudflareAccessGuard, AccessPermissionGuard)
    class OpenController {
      @Get()
      open() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] }),
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
    @UseGuards(CloudflareAccessGuard, AccessPermissionGuard)
    class ScopedController {
      @Get()
      @RequireAccessPermission(['posts:write'])
      handle() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] }),
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
    @UseGuards(CloudflareAccessGuard, AccessPermissionGuard)
    class AmbiguousController {
      @Get()
      @RequireAccessPermission(['posts:write'])
      handle() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] }),
        AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:*'])] }),
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
