# @velajs/better-auth

[better-auth](https://www.better-auth.com/) integration for the [Vela](https://github.com/velajs/vela) framework. Edge-safe, fully DI-driven.

```bash
pnpm add @velajs/better-auth better-auth
```

## Quick start

Construct your better-auth instance once and hand it to `BetterAuthModule.forRoot`. The module installs `AuthGuard` application-wide by default; use `@CurrentUser()` on authenticated routes and mark the small anonymous surface explicitly.

```ts
import { betterAuth } from 'better-auth';
import { Module, Controller, Get, VelaFactory } from '@velajs/vela';
import {
  BetterAuthModule, CurrentUser, Public,
} from '@velajs/better-auth';

const auth = betterAuth({
  database: databaseAdapter, // a drizzle, prisma or kysely adapter
  emailAndPassword: { enabled: true },
  socialProviders: { github: { clientId, clientSecret } },
});

@Controller('/me')
class MeController {
  @Get() me(@CurrentUser() user: { id: string; email: string }) {
    return { id: user.id, email: user.email };
  }

  @Get('/health') @Public(true)
  health() { return { ok: true }; }
}

@Module({
  imports: [BetterAuthModule.forRoot({ auth })],
  controllers: [MeController],
})
class AppModule {}

const app = await VelaFactory.create(AppModule);
export default app; // edge-compatible (.fetch)
```

`POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`, `GET /api/auth/sign-in/social/github` and the rest of better-auth's surface are auto-mounted at `/api/auth/*`.

## Module options

```ts
BetterAuthModule.forRoot({
  auth,                          // pre-constructed betterAuth({ ... }) instance
  issuer: 'my-app:better-auth',  // stable namespace paired with user ids
  basePath: '/api/auth',         // default — must match your better-auth config
  isGlobal: true,                // default — register AuthGuard as APP_GUARD
  mountHandler: true,            // mount /api/auth/* catch-all controller
});
```

Authentication has no allow-by-default compatibility mode. Use `@Public(true)` for routes that intentionally skip authentication, or `@OptionalAuth(true)` when the route accepts an anonymous identity. `isGlobal: false` is intended only for applications that install an equivalent global authentication guard themselves.

## Three composition patterns

### Pattern A — inline (simplest)

```ts
imports: [
  BetterAuthModule.forRoot({
    auth: betterAuth({ database, plugins: [magicLink({ sendMagicLink }), apiKey()] }),
    isGlobal: true,
  }),
]
```

### Pattern B — DI'd plugin construction

`forRootAsync` types the factory's parameters from its `inject` tuple, so they always have matching runtime tokens; a factory without parameters may omit `inject`. It lets Vela services participate in your Better Auth configuration. On Workers, inject the framework `ENV` from `@velajs/vela`: `createCloudflareWorker(AppModule)` seeds the native event environment before DI factories run, and `wrangler types` types its bindings.

```ts
imports: [
  BetterAuthModule.forRootAsync({
    inject: [ENV, EmailService],
    useFactory: (env, email) => betterAuth({
        database: drizzleAdapter(drizzle(env.DB), { provider: 'sqlite' }),
        plugins: [
          magicLink({ sendMagicLink: (data) => email.send(data) }), // DI'd EmailService
          apiKey(),
          twoFactor(),
        ],
    }),
    isGlobal: true,
  }),
]
```

### Pattern C — modular plugin modules

Each feature ships a self-contained vela module that exports a plugin token. AppModule composes them like LEGO. Each module owns its own DI surface; only the public plugin token leaves the boundary.

```ts
// magic-link-auth.module.ts
import { Module, InjectionToken, defineProvider } from '@velajs/vela';
import { magicLink } from 'better-auth/plugins';
import { EmailService } from './email.service';

export const MAGIC_LINK_PLUGIN = new InjectionToken<ReturnType<typeof magicLink>>(
  'app.MagicLinkPlugin',
);

@Module({
  providers: [
    EmailService,
    defineProvider(MAGIC_LINK_PLUGIN, {
      inject: [EmailService],
      useFactory: (email: EmailService) =>
        magicLink({ sendMagicLink: (d) => email.send({ to: d.email, link: d.url }) }),
    }),
  ],
  exports: [MAGIC_LINK_PLUGIN],
})
export class MagicLinkAuthModule {}
```

```ts
// app.module.ts
@Module({
  imports: [
    MagicLinkAuthModule,
    OAuthAuthModule,
    BetterAuthModule.forRootAsync({
      imports: [MagicLinkAuthModule, OAuthAuthModule],
      inject: [MAGIC_LINK_PLUGIN, OAUTH_PLUGIN],
      useFactory: (magicLink, oauth) => betterAuth({ database, plugins: [magicLink, oauth] }),
      isGlobal: true,
    }),
  ],
})
class AppModule {}
```

## Calling better-auth from services & controllers

Inject `BetterAuthService` — a normal `@Injectable()` exposing the underlying better-auth instance plus convenience getters for `.api` and `.handler`. The full `auth.api.*` surface is available: list sessions, revoke, impersonate, anything better-auth exposes server-side.

```ts
import { Inject, Injectable } from '@velajs/vela';
import { BetterAuthService } from '@velajs/better-auth';

@Injectable()
class AdminUserService {
  constructor(
    @Inject(BetterAuthService) private readonly authService: BetterAuthService<typeof auth>,
  ) {}

  listSessions(userId: string) {
    return this.authService.api.listUserSessions({ userId });
  }
  revoke(token: string) {
    return this.authService.api.revokeSession({ sessionToken: token });
  }
}
```

Under `forRootAsync`, the underlying `betterAuth({...})` instance is constructed lazily on first `.auth` / `.api` / `.handler` access. The Workers adapter supplies the typed environment before DI and owns a separate application for each environment, so a cached auth instance never crosses environments.

## Decorators

| Decorator           | Purpose                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `@CurrentUser()`    | Better-auth `User` from the request after guards run                      |
| `@CurrentSession()` | Better-auth `Session` after guards run                                    |
| `@Public(true)`     | Class or method — bypass AuthGuard entirely                              |
| `@OptionalAuth(true)` | Class or method — populate user if present, never throw 401            |

Optional identities are ordinary values: an anonymous caller receives the actual `undefined`, so normal truthiness checks are safe.

```ts
handle(@CurrentUser() user: User | undefined) {
  return { hasUser: Boolean(user) };
}
```

## Guards

- **`AuthGuard`** — singleton. Reads `Authorization` header / cookies via `auth.api.getSession`, validates the full base user/session models, and publishes Vela's trusted principal, tenant, roles, and session expiry for downstream security components. The Better Auth organization plugin's verified `activeOrganizationId` becomes the tenant partition when present. The guard honors only explicit `@Public()` / `@OptionalAuth()` metadata. The generated Better Auth catch-all controller is explicitly public; sharing its URL prefix never makes an application controller public.
Permission and role guards live in `@velajs/authz/vela`: import `PermissionGuard`, `RequirePermission`, `RolesGuard`, and `Roles` there. They read the same trusted identity for Better Auth and Cloudflare Access. Run authentication before authorization.

Global registration is the default: installing the module binds `AuthGuard` to `APP_GUARD`. Routes are deny-by-default; mark public ones with `@Public(true)`. The generated Better Auth controller is already marked public.

When using `ThrottlerModule`, import Better Auth first. Vela then rate-limits by
the verified issuer, subject, principal type, and active organization before it
falls back to a platform-attested client address.

`BETTER_AUTH_OPTIONS` contains runtime configuration; read the auth instance from `BetterAuthService`. Use `createBetterAuthCatchallController()` for a manually mounted catch-all.

## WebSocket upgrades

`BetterAuthUpgradeAuthenticator` authenticates a WebSocket upgrade from the Better Auth session cookie. The application resolves it from the module that declares the gateway, so that module must see `BetterAuthModule`'s exports:

```ts
import { defineProvider, Module } from '@velajs/vela';
import { WebSocketGateway } from '@velajs/vela/websocket';
import {
  BETTER_AUTH_UPGRADE_TENANT,
  BetterAuthModule,
  BetterAuthUpgradeAuthenticator,
} from '@velajs/better-auth';

@WebSocketGateway({
  path: '/boards/:board/ws',
  roomParam: 'board',
  authenticator: BetterAuthUpgradeAuthenticator,
})
class BoardGateway {}

@Module({
  imports: [BetterAuthModule.forRoot({ auth, issuer: 'boards' })],
  providers: [
    BoardGateway,
    // Optional: choose the tenant per connection. Returning undefined refuses it.
    defineProvider(BETTER_AUTH_UPGRADE_TENANT, {
      useValue: (_session, context) => (context.room === 'lobby' ? 'public' : undefined),
    }),
  ],
})
class BoardsModule {}
```

The principal carries the module's `issuer`, as `AuthGuard` does for HTTP, and the identity expires with the session. Every WebSocket identity needs a tenant: by default it is the session's active organization, and a session without one is refused unless a `BETTER_AUTH_UPGRADE_TENANT` resolver supplies a tenant.

## Trusted identity and typing

`@CurrentUser()` and `@CurrentSession()` expose only validated Better Auth data tied to the exact current trusted identity. Public routes, missing/rejected sessions, logout, expiry, and another provider replacing the identity invalidate those values. Hono user variables cannot grant roles or permissions.

Core `getTrustedRequestIdentity(request)` and authz `@CurrentIdentity()` return the verified issuer/subject/type, optional tenant, explicit roles, and credential expiry. WebSocket guards consume only the normalized server connection attachment and do not consult HTTP cookies or arbitrary socket role metadata.

The integration accepts the minimal `BetterAuthInstance` contract instead of `Auth<any>`. `new BetterAuthService(() => auth)` infers the concrete instance and retains plugin API/result types. For an injected service, annotate `BetterAuthService<typeof auth>` with the same configured instance type. The unparameterized service intentionally exposes only the operations the framework itself requires.

Use validated parameter decorators or core's trusted identity reader for authentication state. Import shared permission guards and decorators from `@velajs/authz/vela`.

## Edge-safe DB adapters

`@velajs/better-auth` itself is `node:`-clean. Edge-safety of your runtime depends on your better-auth DB adapter:

| Adapter                                    | Edge-safe |
| ------------------------------------------ | :-------: |
| `drizzleAdapter` + `drizzle-orm/d1`         |     ✅    |
| `drizzleAdapter` + `@neondatabase/serverless` |   ✅    |
| `kyselyAdapter` + `kysely-d1`               |     ✅    |
| `prismaAdapter` + `@prisma/adapter-d1`      |     ✅    |
| `drizzleAdapter` + `better-sqlite3`         |     ❌    |
| `prismaAdapter` (default, no edge client)   |     ❌    |

If you deploy to Cloudflare Workers, smoke-test your bundle for `node:` imports.

## Custom mount path

Set `mountHandler: false` and mount the catch-all yourself if you need a base path other than `/api/auth`:

```ts
import { Controller, All, Req, Inject } from '@velajs/vela';
import { BetterAuthService, Public } from '@velajs/better-auth';

@Public(true)
@Controller('/auth')
class CustomCatchallController {
  constructor(@Inject(BetterAuthService) private auth: BetterAuthService) {}
  @All('/*') handle(@Req() c: Context) { return this.auth.handler(c.req.raw); }
}
```

Pass `basePath: '/auth'` to `BetterAuthModule.forRoot` to mount the generated controller there, and keep your `betterAuth({ basePath: '/auth' })` config in sync. A custom catch-all must carry `@Public(true)` itself. Base paths must be canonical absolute paths: no root mount, trailing slash, wildcards, query/fragment, backslashes, or dot segments.

## License

MIT

## Authentication composition

TenantGuard can run after AuthGuard without losing CurrentUser or CurrentSession. Provider payload survives tenant enrichment, but expires or disappears on clearing or reauthentication. Read the admitted tenant from core identity or CurrentTenant. HTTP-backed custom dispatchers must bind their execution context with bindTrustedRequestContext and authenticate at the outer boundary; AuthGuard then reads existing authentication without a second session lookup.
