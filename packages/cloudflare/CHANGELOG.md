# Changelog

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/feature-flags@3.0.0
  - @velajs/vela@3.0.0

## 2.0.0

### Major Changes

- b99d71a: Compose native Worker applications through modules. QueueModule now initializes transport configuration at bootstrap and publishes driver-owned native routes, removing application-written consumer bridges. Duplicate queue ownership fails at startup. Cloudflare rejects deliveries without a consumer instead of silently accepting them; existing native decorators and envelopes remain supported.
  
  Cloudflare roots accept dynamic modules and asynchronous factories. RPC server modules and injectable named clients reuse the existing schema-validated dispatcher. Deployment checks validate module queue mappings, producer declarations and RPC service bindings. A four-worker example and exact-archive runtime proof cover composition, native delivery and scheduling.

### Patch Changes

- Updated dependencies [a2d2692]
- Updated dependencies [b99d71a]
  - @velajs/feature-flags@2.0.0
  - @velajs/vela@2.0.0

## 1.24.0

### Minor Changes

- efdf854: Add opt-in asynchronous response caching with explicit trusted partitions, bounded JSON replay, and generic scoped generation-based invalidation. Preserve the synchronous CacheService API and provide an independent optional KV invalidation adapter with documented eventual-consistency limits. Preserve absolute expiry during tier backfill and KV physical retention, and fence fills that race with visible invalidation.

### Patch Changes

- Updated dependencies [efdf854]
- Updated dependencies [4a6f5df]
  - @velajs/vela@1.26.0
  - @velajs/feature-flags@1.22.1

## 1.23.0

### Minor Changes

- a95951a: Add explicit Unix/Cloudflare cron dialects, UTC selection and validated schedule metadata for deployment introspection. Fix Sunday-ending ranges and numeric coercion, reject invalid timer delays, and provide native scheduled handler types while preserving exact Workers trigger matching and Node local-time defaults.
- 6b7cf23: Add Standard Schema job definitions with inferred producer input and validated processor output. Preserve original wire input across transport, await all processor outcomes, and offer opt-in strict unmatched routing. Add awaited Cloudflare producer and per-message consumer bridge helpers that validate envelopes, use native attempts, and preserve explicit ack/retry semantics.

  Preserve processor module ownership through discovery and dispatch, resolve scoped components asynchronously, and finish managed invocation work before settling delivery.
- 5205e58: Validate WebSocket correlation envelopes and hibernation attachments, preserve live baselines after refused sends, and add bounded connection-local send admission and incoming work. Existing void send APIs and unversioned 1.x attachments remain supported.

  Drop frames still waiting on Node connection setup after overload or close. Use browser-valid private close codes and reconnect after client-side send admission failures.

### Patch Changes

- 26fe8bf: Resolve queue and scheduled handlers and their pipeline components asynchronously
  in the owning module's child scope. Seed execution context ownership, defer
  handler construction until guards pass, track native waitUntil work through
  provider disposal, and await every matching handler before returning failures.

  Read validated WebSocket entrypoint metadata for upgrade routes so scoped gateways
  do not require a bootstrap instance; retain legacy forwarding metadata scanning.
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
  - @velajs/feature-flags@1.22.1

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/feature-flags@1.22.1
  - @velajs/vela@1.22.1

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
