---
'@velajs/feature-flags': minor
---

Add the structural `globalGuard` option, which registers `FeatureFlagGuard` application-wide and defaults to `true`, so every `@FeatureFlag()` route is gated without `@UseGuards` and a flagged route is never reachable ungated.

**Behavior change:** `isGlobal: true` no longer registers `FeatureFlagGuard` as an `APP_GUARD`; it only makes the module global, as on every module. The app-wide guard is now registered by default instead, whatever `isGlobal` says. `@UseGuards(FeatureFlagGuard)` is redundant under it and evaluates the flag a second time: remove it, or pass `globalGuard: false` to keep gating per route with `@UseGuards(FeatureFlagGuard)`.
