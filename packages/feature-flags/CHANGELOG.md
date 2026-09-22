# Changelog

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

### Patch Changes

- Updated dependencies
  - @velajs/vela@1.28.0

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/vela@3.0.0

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [b99d71a]
  - @velajs/vela@2.0.0

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/vela@1.22.1

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/vela@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/vela@2.0.1

## 2.0.0

Parser-backed flag values and the checked Vela provider contracts.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.0.0

### Major Changes

- 588bd9f: Accept only literal boolean driver results, use own-property manifest lookup, preserve trusted identity fields, and make guards fail closed when context or evaluation is unavailable.

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
