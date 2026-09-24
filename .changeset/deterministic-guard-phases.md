---
'@velajs/vela': minor
'@velajs/better-auth': minor
'@velajs/cloudflare-access': minor
'@velajs/tenant': minor
'@velajs/authz': minor
'@velajs/authz-cedar': minor
'@velajs/feature-flags': patch
---

Global guards run in deterministic phases, whatever order modules register them in: `authenticate` → `tenant` → `authorize` → `feature`. A guard declares its phase with `static readonly phase: GuardPhase` (an instance may carry its own `phase`); a guard without one runs in `feature`, and guards keep registration order within a phase. Global guards still run before controller and method guards. `ThrottlerGuard` and `FeatureFlagGuard` are feature guards, so throttling always partitions by the verified identity; authentication no longer has to be imported before `ThrottlerModule`.

Each integration installs its guard through the `defineModule` `global:` slot (Better Auth through `APP_GUARD`) and takes `guard: 'global' | 'none'`, defaulting to `'global'`: `BetterAuthModule` and `CloudflareAccessModule` authenticate, `TenantModule` admits the tenant, and `AuthzModule` (`PermissionGuard`, `RolesGuard`) and `CedarModule` authorize. With `forRootAsync`, pass `guard` beside the factory. The per-phase markers stay: `@Public`/`@OptionalAuth`, `@TenantIgnored`/`@TenantOptional`, `@CedarPublic`. `TenantGuard` and `CedarGuard` apply to routes declared in modules that can see their module; a route elsewhere, such as another package's own controller, is outside that phase unless it declares `@TenantRequired()` or `@RequireResource()`.

**Behavior change:** `BetterAuthModule`'s `isGlobal` option is replaced by `guard`: `isGlobal: false` becomes `guard: 'none'`.

**Behavior change:** `CloudflareAccessModule`, `TenantModule` and `AuthzModule` now install their guards globally. Remove `@UseGuards(CloudflareAccessGuard)`, `@UseGuards(TenantGuard)` and `@UseGuards(PermissionGuard, RolesGuard)` where the module now covers the route, or pass `guard: 'none'` and keep a fully route-level pipeline (a global guard runs before every route guard). Mark tenant-free routes in tenant modules with `@TenantIgnored()` or `@TenantOptional()`. `AUTHZ_OPTIONS` is typed as the new `AuthzModuleOptions`.

**Behavior change:** `CedarModule`'s `globalGuard: false` is replaced by `guard: 'none'`, and `CedarGuard` denies (403) routes without `@RequireResource()` or `@CedarPublic()` in modules that can see `CedarModule`. Set `undeclared: 'allow'` to let them through as before.
