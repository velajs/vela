# Authentication and authorization

`@velajs/better-auth` mounts Better Auth's handler and authenticates Vela requests. Shared permission/role decisions live in `@velajs/authz/vela`, so every authentication provider uses the same trusted identity.

## Better Auth setup

Construct a Better Auth instance and pass it to `BetterAuthModule.forRoot({ auth, issuer, basePath?, isGlobal?, mountHandler? })`. The default `/api/auth/*` catch-all is explicitly public and the authentication guard is global by default. Keep the Better Auth and Vela base paths aligned. Custom paths must be canonical absolute paths without wildcards, trailing slashes, or dot segments.

For Workers, use `forRootAsync({ inject: [ENV], useFactory: env => betterAuth(...) })`; the factory returns the auth instance directly. The explicit dependency tuple is required, even when empty. Native environment bindings are available before factories run and auth instances are isolated per environment.

```ts
import { Controller, Get, Module } from '@velajs/vela';
import { BetterAuthModule, CurrentUser, Public, OptionalAuth, type User } from '@velajs/better-auth';

@Controller('/me')
class MeController {
  @Get()
  me(@CurrentUser() user: User) { return { id: user.id }; }

  @Get('/health')
  @Public(true)
  health() { return { ok: true }; }

  @Get('/optional')
  @OptionalAuth(true)
  optional(@CurrentUser() user: User | undefined) { return { authenticated: Boolean(user) }; }
}

@Module({ imports: [BetterAuthModule.forRoot({ auth, issuer: 'my-app' })], controllers: [MeController] })
class AppModule {}
```

`@CurrentUser()` / `@CurrentSession()` return validated data only while it is bound to the current trusted identity. Expiry, logout, public routes, rejected sessions, or identity replacement clear that access. Authentication is deny-by-default; there is no permissive `defaultPolicy` mode. Disable global authentication only when installing an equivalent guard.

## One authorization layer

Import `AuthzModule`, `PermissionGuard`, `RequirePermission`, `RolesGuard`, `Roles`, and `CurrentIdentity` from `@velajs/authz/vela`. Authenticate before authorization. `RequirePermission(['posts:write'])` requires every permission; `Roles(['admin', 'editor'])` allows any listed verified local role. Guards do not trust user headers, Hono variables, Better Auth metadata, or arbitrary socket role fields.

Core's trusted identity is keyed by issuer/subject/type and carries tenant, explicit roles, and expiry. Permission decisions fail closed for missing identity/engine, expired credentials, ambiguity, or resolver errors. WebSocket and live delivery use the same verified principal model.

## Preserving provider-specific API types

`BetterAuthInstance` is the minimal framework contract. If application code needs plugin-specific APIs, expose the actual configured instance through a typed token:

```ts
const AUTH = new InjectionToken<typeof auth>('configured auth');
const provider = defineProvider(AUTH, { useValue: auth });
// Register/export provider; app.get(AUTH) preserves this instance's plugin types.
```

The unparameterized `BetterAuthService` exposes the framework's minimal operations. Removed identity symbols are not an integration seam; use current-user/session decorators or the trusted identity reader.

## Tests

`actingAs` from `@velajs/better-auth/testing` creates/signs a real session and returns headers. Set `module.setAuthResolver(actingAs)` then call `module.http.get('/me').actingAs({ email: 'ada@example.com' }).send()`. Principals need a resolvable id or email. See `testing.md` and the auth/authz package READMEs for provider construction and permission policy details.
