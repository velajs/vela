---
'@velajs/vela': minor
'@velajs/better-auth': minor
'@velajs/cloudflare-access': minor
'@velajs/tenant': minor
'@velajs/authz': minor
'@velajs/authz-cedar': minor
'@velajs/feature-flags': patch
'@velajs/storage': patch
'@velajs/cloudflare': patch
'@velajs/graphql': patch
'@velajs/rpc': patch
---

Global guards run in deterministic phases, whatever order modules register them in: `authenticate` → `tenant` → `authorize` → `feature`. A guard declares its phase with `static readonly phase: GuardPhase` (an instance may carry its own `phase`); a guard without one runs in `feature`, and guards keep registration order within a phase. HTTP, WebSocket and RPC dispatch order the constructed guards, so a guard provided by a factory (`APP_GUARD` with `useFactory`) runs in the phase its instance declares; other transports call `orderGuardsByPhase` from `@velajs/vela/module-kit`. Global guards still run before controller and method guards. `ThrottlerGuard` and `FeatureFlagGuard` are feature guards, so throttling always partitions by the verified identity; authentication no longer has to be imported before `ThrottlerModule`.

Each integration installs its guard through the `defineModule` `global:` slot (Better Auth through `APP_GUARD`) and takes `guard: 'global' | 'none'`, defaulting to `'global'`: `BetterAuthModule` and `CloudflareAccessModule` authenticate, `TenantModule` admits the tenant, and `AuthzModule` (`PermissionGuard`, `RolesGuard`) and `CedarModule` authorize. With `forRootAsync`, pass `guard` beside the factory. The per-phase markers stay: `@Public`/`@OptionalAuth`, `@TenantIgnored`/`@TenantOptional`, `@CedarPublic`. The installed `TenantGuard` and `CedarGuard` cover every application route, including routes in modules that do not import `TenantModule` or `CedarModule` (they admit or authorize through the installing module), whether or not the module is registered with `isGlobal`; a route-level `TenantGuard` or `CedarGuard` in a module that cannot see its module answers 403.

An integration package marks its own controller, which applications cannot annotate, with `SkipGuardPhases(['tenant', 'authorize'])` from `@velajs/vela/module-kit`: global guards in those phases do not run for its routes, while authentication, feature and route guards still do. The Better Auth handler, the `@velajs/storage` controller and the `@velajs/cloudflare` signed-download endpoint skip both phases; the GraphQL endpoint skips `authorize`, because resolvers authorize each field.

**Behavior change:** `BetterAuthModule`'s `isGlobal` option is replaced by `guard`: `isGlobal: false` becomes `guard: 'none'`.

**Behavior change:** `CloudflareAccessModule`, `TenantModule` and `AuthzModule` now install their guards globally. Remove `@UseGuards(CloudflareAccessGuard)`, `@UseGuards(TenantGuard)` and `@UseGuards(PermissionGuard, RolesGuard)` where the module now covers the route, or pass `guard: 'none'` and keep a fully route-level pipeline (a global guard runs before every route guard). Mark tenant-free routes with `@TenantIgnored()` or `@TenantOptional()`. `AUTHZ_OPTIONS` is typed as the new `AuthzModuleOptions`.

**Behavior change:** `CedarModule`'s `globalGuard: false` is replaced by `guard: 'none'`, and `CedarGuard` denies (403) application routes without `@RequireResource()` or `@CedarPublic()`, in every module. Set `undeclared: 'allow'` to let them through as before.
