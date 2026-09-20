# Changelog

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/feature-flags@1.22.0
  - @velajs/vela@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/vela@2.0.1
  - @velajs/feature-flags@2.0.1

## 2.0.0

Native binding tokens, per-environment application lifetime, environment-created module graphs, isolated live drivers, and Durable Object live inspection. Includes a complete D1/auth/CRUD/live/Studio starter.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.10.1

### Patch Changes

- 6f04d15: Modernize the package build, validation, and release toolchain.

## 1.7.0 (2026-07-04)

- `cloudflareAdapter()` exported (createCloudflareApp composes vela RuntimeAdapter); `@QueueConsumer`/`@Scheduled` declare open entrypoint kinds; queue/scheduled dispatch runs per-event in a request scope through PipelineRunner (consumer-scoped guards/interceptors/filters; request-scoped deps rebuild per batch); DO WebSocket reads `app.entrypoints`. Requires `@velajs/vela >=1.11.0`.

## 1.6.0 (2026-07-01)

### Added

- **Multi-disk `StorageModule` over R2** (`StorageService.put/get/delete/exists/url`, per-disk templated roots, bucket-by-name via `EnvService`, `R2StorageDriver`) + a signature-gated `StorageController` presign-proxy.
- **`KVCacheStore`** implementing vela's `AsyncCacheStore` — pair with `TieredCacheStore` for a memory→KV cache.
- WebSocket transport for vela's WebSocket gateways (Durable Object backed).

### Fixed

- **Multiple same-type bindings** (e.g. two `KVModule.forRoot` with different bindings) now all initialize — `collectBindingRefs` enumerates every binding ref across module buckets instead of resolving each token once.

## 0.2.0 (2026-04-28)

### Breaking changes

- **`CloudflareFactory` renamed to `createCloudflareApp`.** The factory object exposed exactly one method (`.create`) and was a thin wrapper around `VelaFactory`. Replaced with a plain async function:

  ```ts
  // before
  import { CloudflareFactory } from "@velajs/cloudflare";
  const app = await CloudflareFactory.create(AppModule);

  // after
  import { createCloudflareApp } from "@velajs/cloudflare";
  const app = await createCloudflareApp(AppModule);
  ```

### New

- `CloudflareApplication.scheduled()` now also dispatches `@Cron('expr')` jobs from `@velajs/vela`. Use either the cloudflare-specific `@Scheduled()` decorator or the framework's `@Cron()` decorator — both are matched against the incoming cron event.

### Compatibility

- Requires `@velajs/vela` ≥ 1.0.0 for the `@Cron` integration. The schedule split in vela 0.10 makes its `ScheduleModule` metadata-only, which lets edge platforms drive cron via their native triggers.

## 0.1.0 (2026-04-13)

Initial release.
