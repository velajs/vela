# Authentication and authorization

`@velajs/better-auth` mounts Better Auth's handler and authenticates Vela requests. Shared permission/role decisions live in `@velajs/authz/vela`, so every authentication provider uses the same trusted identity.

## Better Auth setup

Construct a Better Auth instance and pass it to `BetterAuthModule.forRoot({ auth, issuer, basePath?, mountHandler? })`. The default `/api/auth/*` catch-all is explicitly public. Attach the exported `AuthGuard` through `{ provide: APP_GUARD, useExisting: AuthGuard }` or `@UseGuards(AuthGuard)`. Importing the module alone installs no guard. `isGlobal: true` separately makes `BetterAuthService` visible to every module. Keep the Better Auth and Vela base paths aligned. Custom paths must be canonical absolute paths without wildcards, trailing slashes, or dot segments.

For Workers, use `forRootAsync({ inject: [ENV], useFactory: env => ({ issuer, auth: () => betterAuth(...) }) })` in a module declared once at module scope. The factory returns the module options; `auth` may be a function, which runs on the first authentication rather than at bootstrap. The structural options (`basePath`, `mountHandler`) sit next to the factory. A factory without parameters may omit `inject`. Native environment bindings are available before factories run; each application builds its own auth instance on first use, so instances are isolated per environment.

```ts
import { APP_GUARD, Controller, Get, Module } from '@velajs/vela';
import { AuthGuard, BetterAuthModule, CurrentUser, Public, OptionalAuth, type User } from '@velajs/better-auth';

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

@Module({ imports: [BetterAuthModule.forRoot({ auth, issuer: 'my-app' })], controllers: [MeController], providers: [{ provide: APP_GUARD, useExisting: AuthGuard }] })
class AppModule {}
```

`@CurrentUser()` / `@CurrentSession()` return validated data only while it is bound to the current trusted identity. Expiry, logout, public routes, rejected sessions, or identity replacement clear that access. Authentication is deny-by-default; there is no permissive `defaultPolicy` mode. Disable global authentication only when installing an equivalent guard.

## WebSocket upgrades

Gateways authenticate upgrades with a DI-resolved class, never a closure: `@WebSocketGateway({ authenticator: BetterAuthUpgradeAuthenticator })`. It verifies the same Better Auth session cookie before any socket or Durable Object is allocated, uses the module `issuer` for the principal, and expires with the session. Every WebSocket identity carries a tenant: by default the session's active organization, and a session without one is refused. To choose the tenant, or refuse a room, provide `BETTER_AUTH_UPGRADE_TENANT` (`(session, { room, gatewayPath }, request) => tenantId | undefined`) in the module that declares the gateway, where the authenticator resolves. `CloudflareAccessUpgradeAuthenticator` from `@velajs/cloudflare-access/vela` does the same for the Access token and its signed tenant claim. See `websocket.md` for writing your own `UpgradeAuthenticator`.

## Guard phases

Global guards run in fixed phases whatever the import order: `authenticate` (Better Auth `AuthGuard`, `CloudflareAccessGuard`) → `tenant` (`TenantGuard`) → `authorize` (`PermissionGuard`, `RolesGuard`, `CedarGuard`) → `feature` (`ThrottlerGuard`, `FeatureFlagGuard`, and guards that declare no phase). Modules export configured guards. Applications attach aliases such as `{ provide: APP_GUARD, useExisting: TenantGuard }`, preserving overrides and request scope. Keep authentication, tenant and authorization consistently global or consistently route-level. Tenant/Cedar aliases retain their module-owned configuration; ambiguous owners fail. Authz selects the route owner's policy. `guard` installation options are removed.

Each phase keeps its own opt-out marker: `@Public(true)` / `@OptionalAuth(true)` skip or relax authentication, `@TenantIgnored()` / `@TenantOptional()` tenant admission, `@CedarPublic()` resource authorization. The globally installed `TenantGuard` and `CedarGuard` cover every application route, including routes in modules that do not import `TenantModule` or `CedarModule` (those admit or authorize through the installing module) and whether or not it is registered with `isGlobal`. A route-level `@UseGuards(TenantGuard)` or `@UseGuards(CedarGuard)` in a module that cannot see its module denies. `CedarGuard` denies routes without `@RequireResource` or `@CedarPublic` by default; `CedarModule.forRoot({ undeclared: 'allow' })` lets them through. An integration package's own controller, which apps cannot annotate, carries `SkipGuardPhases([...])` from `@velajs/vela/module-kit` instead: the Better Auth handler and the storage controllers skip `tenant` and `authorize`, the GraphQL endpoint skips `authorize` (resolvers authorize each field). Only guards in a skipped phase, which declare `static readonly skippable = true` (`TenantGuard`, `PermissionGuard`, `RolesGuard`, `CedarGuard`), do not run there; other global guards run in every phase, as do authentication, feature and route guards. `skippable` belongs to the guard class, whoever registers it: an integration guard the app registers itself, or an app guard that extends one, is skipped too, unless the subclass declares `static override readonly skippable = false`. Declare policy metadata on generated CRUD controllers with the resource's `decorators` and `endpointDecorators` (see `crud.md`). A factory-provided global guard (`APP_GUARD` with `useFactory`) runs in the phase its built instance declares.

Global guards, including integration guards the application installs, also run outside controller routes: on WebSocket gateway messages, on the check before each push to a socket (with the gateway class), on the reserved `$live` frames that subscribe to live queries or send presence heartbeats (with the framework's `LiveEngine` class) and on RPC procedures. `SkipGuardPhases` applies only to controller routes. With default options, Cedar's deny, `TenantGuard` (a socket context has no request to select the tenant from) and `CloudflareAccessGuard` (HTTP only, in `mode: 'optional'` too) reject socket contexts: gateway messages answer an `exception` frame, pushes are dropped, and `$live` frames get no reply, which the default reporter does not log. RPC procedures require what routes require. `@Roles`, `@RequirePermission` and `@FeatureFlag` on gateway handlers and RPC procedures are enforced; a `@FeatureFlag` on a gateway always rejects its messages (a socket has no request context). Put `@CedarPublic()`/`@RequireResource()` and `@TenantIgnored()`/`@TenantOptional()` on gateway classes (only a class-level marker admits pushes) and RPC providers. No marker reaches `$live` frames, not even one on the `@LiveResolver()` class: give `TenantModule` a `resolve` that admits socket contexts from `normalizeWebSocketUpgradeIdentity(client.data)` (`@velajs/vela/websocket`), set Cedar's `undeclared: 'allow'`, or attach guards only to selected routes. With Cloudflare Access and sockets, authenticate upgrades with `CloudflareAccessUpgradeAuthenticator` and use `@UseGuards(CloudflareAccessGuard, TenantGuard, PermissionGuard)` on HTTP controllers.

## One authorization layer

Import `AuthzModule`, `PermissionGuard`, `RequirePermission`, `RolesGuard`, `Roles`, and `CurrentIdentity` from `@velajs/authz/vela`. `AuthzModule` exports `PermissionGuard` and `RolesGuard`; attach application aliases or route decorators; routes without `@RequirePermission` or `@Roles` pass. `RequirePermission(['posts:write'])` requires every permission; `Roles(['admin', 'editor'])` allows any listed verified local role. Guards do not trust user headers, Hono variables, Better Auth metadata, or arbitrary socket role fields.

Core's trusted identity is keyed by issuer/subject/type and carries tenant, explicit roles, and expiry. `setTrustedRequestIdentity`/`getTrustedRequestIdentity` (from `@velajs/vela/module-kit`) are the single identity model; services read it through `REQUEST_CONTEXT` with the read-only `TRUSTED_REQUEST_IDENTITY` key (`set()` throws). Permission decisions fail closed for missing identity/engine, expired credentials, ambiguity, or resolver errors. WebSocket and live delivery use the same verified principal model.

Tenant enrichment of the same identity preserves validated provider payloads;
identity replacement invalidates them. Custom HTTP-backed execution contexts
must bind the original request through `bindTrustedRequestContext`, retaining
expiry and replacement checks. Queue or socket payload fields cannot establish
this bridge.

The opt-in `authorizationAudit()` runtime adapter from `@velajs/authz/vela`
checks mounted HTTP role/permission metadata against visible guards at startup.
It reads provider snapshots without constructing request providers. Its default
mode throws on missing or unverifiable wiring; `mode: 'warn'` reports diagnostics.
Opaque factories may be unverifiable. An audit supplements runtime guards; it
does not grant authority or prove a custom guard's implementation.

## Preserving provider-specific API types

`BetterAuthInstance` is the minimal framework contract. If application code needs plugin-specific APIs, expose the actual configured instance through a typed token:

```ts
const AUTH = new InjectionToken<typeof auth>('configured auth');
const provider = defineProvider(AUTH, { useValue: auth });
// Register/export provider; app.get(AUTH) preserves this instance's plugin types.
```

The unparameterized `BetterAuthService` exposes the framework's minimal operations. Use current-user/session decorators or the trusted identity reader for authentication state.

## Tests

`actingAs` from `@velajs/better-auth/testing` creates/signs a real session and returns headers. Set `module.setAuthResolver(actingAs)` then call `module.http.get('/me').actingAs({ email: 'ada@example.com' }).send()`. Principals need a resolvable id or email. See `testing.md` and the auth/authz package READMEs for provider construction and permission policy details.
