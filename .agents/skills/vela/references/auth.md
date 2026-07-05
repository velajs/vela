# Authentication (`@velajs/better-auth`)

Wraps [better-auth](https://better-auth.com) as a Vela module: mount its handler, guard routes, and inject the current user/session through DI. Subpaths: `.` and `./testing`. Peer: `better-auth >=1.2.0` (plus `@velajs/vela`, `hono`).

## Setup — `BetterAuthModule.forRoot`

You construct the better-auth `auth` instance yourself and pass it in:

```ts
import { betterAuth } from 'better-auth';
import { BetterAuthModule } from '@velajs/better-auth';

const auth = betterAuth({ /* your better-auth config, incl. basePath */ });

@Module({ imports: [BetterAuthModule.forRoot({ auth, isGlobal: true })] })
class AppModule {}
```

`BetterAuthModuleOptions` (+ `isGlobal?`, `key?` on `forRoot`):

| Option | Default | Notes |
|---|---|---|
| `auth` | — (required) | a built `BetterAuthInstance` (`Auth<any>`) |
| `basePath` | `'/api/auth'` | where the catch-all handler mounts (relative to vela's `globalPrefix`) |
| `isGlobal` | `false` | make the module global **and** register `AuthGuard` app-wide |
| `defaultPolicy` | `'deny'` | `'allow'` lets unauthenticated requests through when no `@Public`/`@OptionalAuth` |
| `mountHandler` | `true` | `false` skips mounting the `/api/auth/*` routes |

`forRootAsync({ inject, imports, useFactory, ... })` builds the instance lazily — its `useFactory` **returns the `BetterAuthInstance` directly** (not `{ auth }`), and construction is deferred to first `.auth`/`.handler` access (so a runtime adapter can capture `env` first — e.g. on Cloudflare).

## The auto-mounted `/api/auth/*` handler

With `mountHandler` on (the default), the module registers a `@Public` catch-all controller at `basePath` whose `@All('/*')` route delegates every request to better-auth's own web handler (`auth.handler(request)`). `basePath` must line up with `globalPrefix + basePath` of your `betterAuth({ basePath })`. Set `mountHandler: false` to wire the handler yourself. `createBetterAuthCatchallController(basePath)` is exported if you need to build it manually.

## Guarding routes — `AuthGuard`

Register `AuthGuard` per route via `@UseGuards(AuthGuard)`, or app-wide via `forRoot({ isGlobal: true })`. On each request it:

1. Passes through immediately for `@Public` handlers, and for requests to the auth base path itself (so the catch-all runs unauthenticated).
2. Calls `auth.api.getSession({ headers })`; on a session it attaches `user` and `session` to the request context (readable via the decorators below) and allows.
3. With no session: allows when `defaultPolicy: 'allow'` or the handler is `@OptionalAuth`; otherwise throws `UnauthorizedException`.

```ts
import { AuthGuard, CurrentUser, CurrentSession, Public, OptionalAuth, Roles } from '@velajs/better-auth';
import type { User, Session } from '@velajs/better-auth';

@UseGuards(AuthGuard)
@Controller('/me')
class MeController {
  @Get()
  me(@CurrentUser() user: User, @CurrentSession() session: Session) {
    return { id: user.id, session: session.id };
  }

  @Public()                    // bypasses AuthGuard entirely
  @Get('/health')
  health() { return { ok: true }; }

  @OptionalAuth()              // populates user if present, never 401s
  @Get('/maybe')
  maybe(@CurrentUser() user: User) { return { anon: user?.id == null }; }
}
```

- `@CurrentUser()` / `@CurrentSession()` are **lazy** param decorators returning better-auth's `User` / `Session`. Because they return a lazy proxy, probe presence with `user?.id != null` — never `!!user`.
- `@Public()` and `@OptionalAuth()` are `Reflector` boolean decorators; apply at method or controller level.
- `@Roles(['admin', 'editor'])` + `RolesGuard` gate on `user.role` (comma-normalized). The decorator is `Reflector.createDecorator<string[]>` — it takes a single array argument.

Exported tokens/keys: `BETTER_AUTH_OPTIONS`, `AUTH_USER_KEY`, `AUTH_SESSION_KEY`. Types: `BetterAuthInstance`, `BetterAuthModuleOptions`, `User`, `Session`.

## Testing — `@velajs/better-auth/testing`

`actingAs` is a ready `ActingAsResolver` for `@velajs/testing`: it finds-or-creates the principal's user, mints a signed session, and returns a `Cookie` header — so authenticated requests just work:

```ts
import { actingAs } from '@velajs/better-auth/testing';

// as the module default resolver:
module.setAuthResolver(actingAs);
await module.http.get('/me').actingAs({ email: 'ada@example.com' }).send();

// or per request (reuse an existing user by id):
await module.http.get('/me').actingAs({ id: existingUserId }, actingAs).send();

// or call it directly to get headers for a raw request:
const headers = await actingAs(moduleRef, { email: 'ada@example.com', name: 'Ada' });
const res = await app.getHonoApp().request('/me', { headers });
```

`actingAs(module, principal)` requires the principal to carry a resolvable `id` or `email`; extra fields (e.g. `role`) are forwarded to user creation. Its `(module, principal) => Promise<Headers>` shape is exactly `@velajs/testing`'s `ActingAsResolver` (declared structurally, so the subpath carries no hard dependency on the testing package). See `references/testing.md` for the harness side.
