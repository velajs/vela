# Changelog

## 2.0.0

Parser-backed flag values and the checked Vela provider contracts.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 0.1.1

### Patch Changes

- 2b92134: Modernize the package build, validation, and release toolchain.

## 0.1.0

Initial release.

- Driver-based feature flags for Vela, authored purely on the public API
  (`defineModule`, `Reflector`, guards) — edge-pure, no `node:*`/`Buffer`/`process`.
- `FeatureFlagDriver` contract + in-package `MemoryFlagDriver` (default driver and test fake).
- `FeatureFlagsService`: manifest defaults, never-throw evaluation (`getBoolean/String/Number/Object`
  Value/Details), immutable `use(driver)`, `all()`, and a per-request `context` merge.
- `FeatureFlagsModule` (`defineModule`, `lazy: true`) with `forRoot`/`forRootAsync` and an
  `isGlobal` app-wide guard option.
- `@FeatureFlag(key, { onDisabled })` + `FeatureFlagGuard` to hide routes (404) or forbid them (403).
- `@velajs/feature-flags/testing` subpath: memory driver helpers + `createTestFeatureFlags()`.
