---
'@velajs/feature-flags': minor
---

Add the structural `globalGuard` option, which registers `FeatureFlagGuard` application-wide.

**Behavior change:** `isGlobal: true` no longer registers `FeatureFlagGuard` as an `APP_GUARD`; it only makes the module global, as on every module. Use `FeatureFlagsModule.forRoot({ globalGuard: true })` (with `isGlobal: true` as well when other modules inject the service).
