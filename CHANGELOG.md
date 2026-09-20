# Changelog

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
