# Changelog

## 0.2.0 (2026-07-04)

- Rebuilt on vela 1.11 `defineModule` + `lazyProvider` (hand-rolled forRoot/forRootAsync deleted; public API byte-identical). Requires `@velajs/vela >=1.11.0`.


## 0.1.0 (unreleased)

- Initial release: edge-first, driver-based object/file storage for Vela.
  - `StorageModule` (`forRoot` / `forRootAsync`) with multi-bucket named instances.
  - `Storage` facade with capability-gating, retry/timeout/abort, and multipart orchestration.
  - Drivers: in-memory, S3 / S3-compatible (aws4fetch SigV4), R2 native binding, R2 over HTTP + hybrid.
  - Opt-in `storageSdkDriver()` bridge for `@storagesdk/adapters` (Node/Bun).
