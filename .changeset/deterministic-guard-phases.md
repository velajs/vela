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
'@velajs/rpc': minor
'@velajs/crud': minor
---

Global guards run in deterministic phases, whatever order modules register them in: `authenticate` → `tenant` → `authorize` → `feature`. A guard declares its phase with `static readonly phase: GuardPhase` (an instance may carry its own `phase`); a guard without one runs in `feature`, and guards keep registration order within a phase. HTTP, WebSocket and RPC dispatch order the constructed guards, so a guard provided by a factory (`APP_GUARD` with `useFactory`) runs in the phase its instance declares; other transports call `orderGuardsByPhase` from `@velajs/vela/module-kit`. Global guards still run before controller and method guards. `ThrottlerGuard` and `FeatureFlagGuard` are feature guards, so throttling always partitions by the verified identity; authentication no longer has to be imported before `ThrottlerModule`.

Each integration installs its guard globally (through the `defineModule` `global:` slot or an `APP_GUARD` provider under the guard's own token, so `overrideGuard(TenantGuard)` and `overrideGuard(CedarGuard)` in `@velajs/testing` reach the installed instance) and takes `guard: 'global' | 'none'`, defaulting to `'global'`: `BetterAuthModule` and `CloudflareAccessModule` authenticate, `TenantModule` admits the tenant, and `AuthzModule` (`PermissionGuard`, `RolesGuard`) and `CedarModule` authorize. `guard` is a structural option with that default, so `forRoot({ ... })` and `forRoot({ ..., guard: 'global' })` are one instance; with `forRootAsync`, pass it beside the factory. The per-phase markers stay: `@Public`/`@OptionalAuth`, `@TenantIgnored`/`@TenantOptional`, `@CedarPublic`. The installed `TenantGuard` and `CedarGuard` cover every application route, including routes in modules that do not import `TenantModule` or `CedarModule` (they admit or authorize through the installing module), whether or not the module is registered with `isGlobal`; a route-level `TenantGuard` or `CedarGuard` in a module that cannot see its module answers 403.

An integration package marks its own controller, which applications cannot annotate, with `SkipGuardPhases(['tenant', 'authorize'])` from `@velajs/vela/module-kit`: the global guards integrations install in those phases do not run for its routes. Only a guard that declares `static readonly skippable = true` is skipped, as `TenantGuard`, `PermissionGuard`, `RolesGuard` and `CedarGuard` do; other global guards run in every phase on these routes, as do authentication, feature and route guards. `skippable` belongs to the guard class, whoever registers it: an application guard that extends an integration guard inherits it, and declares `static override readonly skippable = false` to run on these routes too. The Better Auth handler, the `@velajs/storage` controller and the `@velajs/cloudflare` signed-download endpoint skip both phases; the GraphQL endpoint skips `authorize`, because resolvers authorize each field.

`@Crud()` and `CrudModule.forFeature()` resources take `decorators` for the controller class and `endpointDecorators` for each endpoint's handler, so an application declares route metadata on controllers it does not write, such as Cedar policy under the default deny: `defineCrudFeature({ path: '/notes', model, decorators: [RequireResource({ action: 'note:write', resourceType: 'Note' })], endpointDecorators: { list: [CedarPublic()] } })`. They apply as if written above the class or method in order, so endpoint metadata overrides class-level metadata, and an `@Override`'d endpoint keeps them. A method decorator that changes or returns the descriptor wraps the handler the route calls. Class decorators apply after the generated handlers exist, as TypeScript applies them after the methods, so one that decorates or wraps each method reaches every endpoint, and one that writes method metadata overrides an `endpointDecorators` value for that key, exactly as in hand-written TypeScript; a class decorator that returns a replacement class is rejected.

`RpcModule` and `rpcAdapter` run the `authorize` policy in the global `authorize` phase, before the other global authorize guards: after global authentication and tenant admission, so a policy can read the trusted identity those guards publish.

**Behavior change:** `CloudflareAccessModule`, `TenantModule` and `AuthzModule` now install their guards globally. Remove `@UseGuards(CloudflareAccessGuard)`, `@UseGuards(TenantGuard)` and `@UseGuards(PermissionGuard, RolesGuard)` where the module now covers the route, or pass `guard: 'none'` and keep a fully route-level pipeline (a global guard runs before every route guard). Mark tenant-free routes with `@TenantIgnored()` or `@TenantOptional()`. `AUTHZ_OPTIONS` is typed as the new `AuthzModuleOptions`.

**Behavior change:** `CedarModule`'s `globalGuard: false` is replaced by `guard: 'none'`, and `CedarGuard` denies (403) application routes without `@RequireResource()` or `@CedarPublic()`, in every module. Set `undeclared: 'allow'` to let them through as before. `undeclared` is structural, like `guard` (default `'deny'`): with `forRootAsync`, pass it beside the factory, which cannot return it.

**Behavior change:** The RPC `authorize` policy runs after global authentication and tenant guards instead of before every global guard. A policy that denied callers because the identity was not yet published now sees it.
