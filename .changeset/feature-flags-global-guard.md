---
'@velajs/feature-flags': minor
---

Add the structural `guard: 'global' | 'none'` option, the same option the authentication, tenant and authorization modules take. `'global'`, the default, registers `FeatureFlagGuard` application-wide, so every `@FeatureFlag()` route is gated without `@UseGuards` and a flagged route is never reachable ungated; `'none'` gates only the routes that declare `@UseGuards(FeatureFlagGuard)`. Any other value throws when `forRoot()` or `forRootAsync()` is called.

**Behavior change:** `isGlobal: true` no longer registers `FeatureFlagGuard` as an `APP_GUARD`; it only makes the module global, as on every module. The app-wide guard is now registered by default instead, whatever `isGlobal` says. `@UseGuards(FeatureFlagGuard)` is redundant under it and evaluates the flag a second time: remove it, or pass `guard: 'none'` to keep gating per route with `@UseGuards(FeatureFlagGuard)`.

`FeatureFlagGuard` declares the `feature` phase (`static readonly phase = 'feature'`), so the global guard runs after the authentication, tenant and authorization guards whatever the import order, as @velajs/vela 1.31.0 orders global guards by phase.

**Behavior change:** the app-wide guard runs wherever the application's global guards run, including WebSocket gateway messages and RPC procedures, so a `@FeatureFlag()` there is enforced without `@UseGuards`. A socket message has no request context to evaluate the flag for, so a `@FeatureFlag()` on a gateway handler rejects every message with an `exception` frame, even when the flag is on, and one on the gateway class also stops the gateway's pushes and live-query subscriptions. Keep flags on HTTP routes and RPC procedures, or pass `guard: 'none'`.

`guard` defaults to `'global'` as a structural default, so `forRoot({ manifest })`, `forRoot({ manifest, guard: 'global' })` and `forRoot({ manifest, lazy: true })` (the module is lazy by default) are one instance with one app-wide guard. With `forRootAsync`, pass `guard` beside the factory.

**Behavior change:** registrations are keyed by `guard` instead of by all their options, so a second `FeatureFlagsModule` with the same `guard` and other drivers or another manifest fails bootstrap instead of becoming another instance. Give each additional registration its own `key`.
