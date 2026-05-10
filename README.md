# @velajs/better-auth

[better-auth](https://www.better-auth.com/) integration for the [Vela](https://github.com/velajs/vela) framework. Edge-safe, fully DI-driven.

```bash
pnpm add @velajs/better-auth better-auth
```

## Quick start

Construct your better-auth instance once, hand it to `BetterAuthModule.forRoot`, then use `AuthGuard` + `@CurrentUser()` like any other vela primitive.

```ts
import { betterAuth } from 'better-auth';
import { Module, Controller, Get, UseGuards, VelaFactory } from '@velajs/vela';
import {
  BetterAuthModule, AuthGuard, CurrentUser, Public,
} from '@velajs/better-auth';

const auth = betterAuth({
  database: /* drizzle / prisma / kysely adapter */,
  emailAndPassword: { enabled: true },
  socialProviders: { github: { clientId, clientSecret } },
});

@Controller('/me')
@UseGuards(AuthGuard)
class MeController {
  @Get() me(@CurrentUser() user: { id: string; email: string }) {
    return { id: user.id, email: user.email };
  }

  @Get('/health') @Public(true)
  health() { return { ok: true }; }
}

@Module({
  imports: [BetterAuthModule.forRoot({ auth, isGlobal: true })],
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
  basePath: '/api/auth',         // default — must match your better-auth config
  isGlobal: false,               // register AuthGuard as APP_GUARD (deny-by-default)
  defaultPolicy: 'deny',         // 'deny' | 'allow' for unauthenticated requests
  mountHandler: true,            // mount /api/auth/* catch-all controller
});
```

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

`forRootAsync` lets vela services participate in your better-auth config. Required for Cloudflare D1 / Hyperdrive bindings, since env bindings only resolve at request time.

```ts
imports: [
  D1Module.forRoot({ binding: 'DB' }),
  BetterAuthModule.forRootAsync({
    inject: [D1Service, EmailService],
    useFactory: (d1: D1Service, email: EmailService) => ({
      auth: betterAuth({
        database: drizzleAdapter(drizzle(d1.binding), { provider: 'sqlite' }),
        plugins: [
          magicLink({ sendMagicLink: (data) => email.send(data) }), // DI'd EmailService
          apiKey(),
          twoFactor(),
        ],
      }),
    }),
    isGlobal: true,
  }),
]
```

### Pattern C — modular plugin modules

Each feature ships a self-contained vela module that exports a plugin token. AppModule composes them like LEGO. Each module owns its own DI surface; only the public plugin token leaves the boundary.

```ts
// magic-link-auth.module.ts
import { Module, InjectionToken } from '@velajs/vela';
import { magicLink } from 'better-auth/plugins';
import { EmailService } from './email.service';

export const MAGIC_LINK_PLUGIN = new InjectionToken<ReturnType<typeof magicLink>>(
  'app.MagicLinkPlugin',
);

@Module({
  providers: [
    EmailService,
    {
      provide: MAGIC_LINK_PLUGIN,
      inject: [EmailService],
      useFactory: (email: EmailService) =>
        magicLink({ sendMagicLink: (d) => email.send({ to: d.email, link: d.url }) }),
    },
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
      useFactory: (magicLink, oauth) => ({
        auth: betterAuth({ database, plugins: [magicLink, oauth] }),
      }),
      isGlobal: true,
    }),
  ],
})
class AppModule {}
```

## Calling better-auth from services & controllers

Inject the auth instance via the `BETTER_AUTH` token. The full `auth.api.*` surface is available — list sessions, revoke, impersonate, anything better-auth exposes server-side.

```ts
import { Inject, Injectable } from '@velajs/vela';
import { BETTER_AUTH, type BetterAuthInstance } from '@velajs/better-auth';

@Injectable()
class AdminUserService {
  constructor(@Inject(BETTER_AUTH) private readonly auth: BetterAuthInstance) {}

  listSessions(userId: string) {
    return this.auth.api.listUserSessions({ userId });
  }
  revoke(token: string) {
    return this.auth.api.revokeSession({ sessionToken: token });
  }
}
```

## Decorators

| Decorator           | Purpose                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `@CurrentUser()`    | Lazy parameter — better-auth `User` from the request (read by AuthGuard) |
| `@CurrentSession()` | Lazy parameter — better-auth `Session`                                   |
| `@Public(true)`     | Class or method — bypass AuthGuard entirely                              |
| `@OptionalAuth(true)` | Class or method — populate user if present, never throw 401            |
| `@Roles(['admin'])` | Method — read by `RolesGuard`. Compares against `user.role`.            |

`@CurrentUser()` returns a lazy proxy. It's always object-truthy (because it's a proxy). When auth is optional, probe a property instead of `!!user`:

```ts
handle(@CurrentUser() user: User | undefined) {
  return { hasUser: user?.id != null };  // ✓ correct
}
```

## Guards

- **`AuthGuard`** — singleton. Reads `Authorization` header / cookies via `auth.api.getSession`, populates `REQUEST_CONTEXT`. Honors `@Public()` and `@OptionalAuth()` overrides. Always lets requests under `basePath` through (so the catch-all controller can run unauthenticated).
- **`RolesGuard`** — singleton. Reads `@Roles([...])` metadata, compares against `user.role`. Use with `@UseGuards(AuthGuard, RolesGuard)` — order matters.

Global registration: pass `isGlobal: true` to `forRoot` (binds AuthGuard to `APP_GUARD`). Routes are deny-by-default; mark public ones with `@Public(true)`.

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
import { Controller, All, Req, Inject, Injectable } from '@velajs/vela';
import { BETTER_AUTH, Public } from '@velajs/better-auth';

@Public(true)
@Controller('/auth')
@Injectable()
class CustomCatchallController {
  constructor(@Inject(BETTER_AUTH) private auth: BetterAuthInstance) {}
  @All('/*') handle(@Req() c: Context) { return this.auth.handler(c.req.raw); }
}
```

Pass `basePath: '/auth'` to `BetterAuthModule.forRoot` so `AuthGuard` skips the right paths, and keep your `betterAuth({ basePath: '/auth' })` config in sync.

## License

MIT
