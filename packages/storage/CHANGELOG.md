# Changelog

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [b99d71a]
  - @velajs/vela@2.0.0

## 1.23.0

### Minor Changes

- 5bbbe6b: Add metadata-only stat/listMetadata access and preserve exact native raw binding types through storage facades, services, R2/hybrid drivers, and built-in middleware. Add explicit R2 listing metadata inclusion and Workers-native type coverage. Clarify portable storage versus the compatible legacy Cloudflare HMAC proxy API.

### Patch Changes

- 6588211: Normalize generated CRUD names and storage prefixes in linear passes so long
  separator runs cannot cause regular-expression backtracking. Preserve existing
  operation IDs, controller/DTO names, and prefix scoping behavior.
- 4bf9081: Report actual native R2 range lengths and reject invalid ranges before I/O. Enforce storage deadlines and cancellation without retrying abandoned operations whose writes may still commit. Dispose late download bodies and multipart handles, stop follow-up mutations after cancellation, and document provider-side uncertainty and stream ownership.
- Updated dependencies [c6a43a6]
- Updated dependencies [bbe62d4]
- Updated dependencies [a6ef933]
- Updated dependencies [dae3654]
- Updated dependencies [77cca9e]
- Updated dependencies [b9f75f5]
- Updated dependencies [df47ea8]
- Updated dependencies [af019bf]
- Updated dependencies [6df1059]
- Updated dependencies [bdd90a1]
- Updated dependencies [8a3923f]
- Updated dependencies [c7d108b]
- Updated dependencies [1c7f635]
- Updated dependencies [636ffbc]
- Updated dependencies [54f8864]
- Updated dependencies [f49db45]
- Updated dependencies [4fde903]
- Updated dependencies [6a1b5b3]
- Updated dependencies [a95951a]
- Updated dependencies [9e82187]
- Updated dependencies [c5a3cb0]
- Updated dependencies [363fb71]
- Updated dependencies [de4e57e]
- Updated dependencies [0765aaa]
- Updated dependencies [6b7cf23]
- Updated dependencies [5205e58]
- Updated dependencies [ae45689]
  - @velajs/vela@1.25.0

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

Native Workers bindings and checked schema boundaries; validated against real workerd bindings.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.0.0

### Major Changes

- 38f91ae: Secure browser-direct multipart uploads with actor-bound, key-bound, staging-key-bound, size-bound, part-count-bound, expiring HMAC grants. Multipart HTTP clients must now send the exact object size at creation and echo the returned grant on part signing, completion, and abort requests. Completion occurs under a reserved quarantine key and promotes the object only after validation. Storage dynamic-module identity now includes driver/factory, hooks, authorizer, and multipart-secret identity so distinct security configurations cannot collapse. HTTP routes are deny-only without an explicit authorizer; the insecure `defaultPolicy: 'allow'` compatibility path is removed. Proxy downloads now default to attachment, block HTML/SVG inline rendering, and emit `X-Content-Type-Options: nosniff`. Browser-facing `/sign-download` URLs now resolve object metadata and bind an attachment `Content-Disposition` into the provider signature.

## 0.3.2

### Patch Changes

- cb3140a: Modernize the package build, validation, and release toolchain.

## 0.2.0 (2026-07-04)

- Rebuilt on vela 1.11 `defineModule` + `lazyProvider` (hand-rolled forRoot/forRootAsync deleted; public API byte-identical). Requires `@velajs/vela >=1.11.0`.

## 0.1.0 (unreleased)

- Initial release: edge-first, driver-based object/file storage for Vela.
  - `StorageModule` (`forRoot` / `forRootAsync`) with multi-bucket named instances.
  - `Storage` facade with capability-gating, retry/timeout/abort, and multipart orchestration.
  - Drivers: in-memory, S3 / S3-compatible (aws4fetch SigV4), R2 native binding, R2 over HTTP + hybrid.
  - Opt-in `storageSdkDriver()` bridge for `@storagesdk/adapters` (Node/Bun).
