# Changelog

## 1.30.0

### Minor Changes

- 44023fc: `@velajs/cloudflare` exports only the Cloudflare adapter and its platform pieces, so each framework API has one import path. It requires `@velajs/vela` with the tiered entry points and imports its seams from `@velajs/vela/module-kit`, `@velajs/vela/schedule` and the other feature subpaths.
  
  The package now publishes one JavaScript module per source file instead of shared chunks, so a bundler drops the features a Worker never imports. A shared chunk kept every decorated class it held, so a Worker that only calls `createCloudflareWorker()` shipped the storage module with the signed-URL crypto its controller uses, the KV and feature-flag drivers and the Durable Object host; it no longer does, which takes 6,975 bytes gzipped off that minimal Worker. Entry points, exports and type declarations are unchanged.
  
  **Behavior change:** the WebSocket gateway API is no longer re-exported from `@velajs/cloudflare`. Import it from `@velajs/vela/websocket`:
  
  | Old import | New import | Names |
  |---|---|---|
  | `@velajs/cloudflare` | `@velajs/vela/websocket` | `ConnectedSocket`, `MessageBody`, `OnGatewayConnection`, `OnGatewayDisconnect`, `OnGatewayInit`, `SubscribeMessage`, `UpgradeAuthenticator`, `WebSocketGateway`, `WebSocketServer`, `WebSocketUpgradeAuthenticationContext`, `WebSocketUpgradeIdentity`, `WsClient`, `WsException`, `WsMessage`, `WsResponse`, `WsServer` |

### Patch Changes

- Updated dependencies [4d0342b]
- Updated dependencies [4467619]
- Updated dependencies [7372d90]
- Updated dependencies [c101033]
- Updated dependencies [4d0342b]
  - @velajs/feature-flags@1.30.0
  - @velajs/vela@1.30.0

## 1.29.0

### Minor Changes

- 416650e: Cron triggers run core `@Cron()` jobs through `invokeScheduledJob`, the same primitive as the Node executor: the adapter runs every `@Cron` job whose expression is exactly the trigger string, in a fresh invocation scope, and the trigger settles after every matching job and its `EXECUTION_LIFETIME` work settle. Closing the application aborts the invocation signal of running jobs and waits for them.
  
  Add `CLOUDFLARE_SCHEDULED_EVENT`, a request-scoped token seeded into each job's invocation scope. Its `CloudflareScheduledEvent` value carries the trigger's `cron`, `scheduledTime` and a `noRetry()` already bound to the native controller. The token provides itself as request-scoped in every container, so a class that injects it is request-scoped wherever the module graph boots, including a `VelaWebSocketDurableObject`, `vela` CLI commands and `Test.createTestingModule()`, and is constructed per invocation instead of at bootstrap; resolving it outside a scheduled invocation throws. `ScheduledEvent` (the input of `scheduled()`) now also accepts the controller's optional `noRetry`.
  
  Signed `ScheduleModule` dispatch now works on Workers: the adapter's invocation transport re-enters the signed route, so its global guards run.
  
  The adapter reports schedule declarations a cron trigger cannot honor through the diagnostics policy: a `@Cron` without a dialect whose weekday field has digits or whose day fields are both restricted, `dialect: 'unix'`, `timeZone: 'local'`, `@Interval` jobs, which never run on Workers, and `@UseGuards`, `@UseInterceptors` or `@UseFilters` declared for a cron job. The default `'log'` mode warns once per declaration and never fails the first event; `'throw'` fails bootstrap. `vela deploy check` rejects the cron declarations and `@Interval` jobs before deployment (`ambiguous-cron-dialect`, `incompatible-cron-options`, `unsupported-interval`).
  
  The adapter provides `SCHEDULE_INVOCATION_SEED`: a cron job fired outside a trigger, such as by Studio's run-now, receives a synthetic `CLOUDFLARE_SCHEDULED_EVENT` whose `cron` is the job's expression, whose `scheduledTime` is the invocation's, and whose `noRetry()` does nothing.
  
  **Behavior change:** `@Scheduled` and `parseScheduledMetadata` are removed, along with the `ScheduledMetadata`, `ScheduledController`, `ScheduledContext` and `ScheduledHandler` types and the `cf:scheduled` and `cf:vela-cron` entrypoint kinds. Replace `@Scheduled(expr)` with `@Cron(expr, { dialect: 'cloudflare' })` from `@velajs/vela`. Cron jobs appear only as `schedule:cron` entrypoints.
  
  **Behavior change:** scheduled handlers receive only a `ScheduleInvocation` (`kind`, `expression` equal to the trigger string, `scheduledTime`, `signal`), identical to Node, instead of `(controller, env, ctx)`. Inject `ENV` for bindings, `CLOUDFLARE_SCHEDULED_EVENT` for `noRetry()`, and `EXECUTION_LIFETIME` for `waitUntil()`.
  
  **Behavior change:** scheduled jobs no longer run interceptors or filters declared with `@UseInterceptors` or `@UseFilters`, matching the Node executor. A job that declares `@UseGuards` on its class, method or module, whose guards the adapter used to run on each trigger, is now refused instead of running unguarded: the trigger fails, the job is never constructed, and the refusal is reported through the exception reporter (guards do not run for directly dispatched scheduled jobs — use `ScheduleModule.forRoot({ dispatch: { kind: 'signed', ... } })` or remove the guard). Other jobs on the same trigger still run. Queue consumers keep their guards, interceptors and filters. Use signed `ScheduleModule` dispatch to run a job through a route's request pipeline, or remove the guard.
  
  **Behavior change:** a `@Cron` job that declares `@UseGuards`, `@UseInterceptors` or `@UseFilters` on its class, method or module is reported through the diagnostics policy, because those components never run for scheduled jobs: the default `'log'` mode warns once and `'throw'` fails bootstrap. Move them to a signed `ScheduleModule` dispatch route.
- a3e2b38: The Cloudflare runtime seeds the native environment as the framework `ENV`, in the Worker and in every `VelaWebSocketDurableObject`, and types it with the environment `wrangler types` generates: the package augments `VelaEnv` with `Cloudflare.Env`, so `@InjectEnv() env: VelaEnv`, `inject: [ENV]` factories and `registerAs` factories see your bindings, variables and secrets typed. Run `wrangler types` (for example with `--include-runtime=false` alongside `@cloudflare/workers-types`) so `Cloudflare.Env` declares them. The per-environment application cache and the environment identity assertion are unchanged.
  
  `createCloudflareWorker` and `createCloudflareApp` accept `adapters: RuntimeAdapter[]`, composed after the Cloudflare adapter for each application, so a Worker entry can stay `export default createCloudflareWorker(AppModule, { adapters: [...] })` without a hand-written per-environment cache.
  
  **Behavior change:** the `envToken` option is removed from `createCloudflareWorker`, `createCloudflareApp`, `cloudflareAdapter`, `VelaWebSocketDurableObject` and `buildDoRuntime`, with no alias. Delete the application's environment `InjectionToken` and inject `ENV` from `@velajs/vela` instead: `createCloudflareWorker(AppModule)`, `VelaWebSocketDurableObject(AppModule)`, `cloudflareAdapter({ env })`. `CloudflareApplication` and `CloudflareRoot` are no longer generic; their environment type is `VelaEnv`.
  
  **Behavior change:** the `@Env()` parameter decorator is removed. Inject the environment with `@InjectEnv()` in a constructor, or read a binding in a factory with `inject: [ENV]`.
  
  **Behavior change:** ENV now carries every binding, variable and secret of the Worker, so framework readers pick up values such as `URL_SIGNING_SECRET` (URL and invocation signing) and `VELA_STUDIO_TOKEN` (Studio) automatically once they are set as variables or secrets. Values come from outside the program: validate each value your code reads before relying on it.
- 2ae8505: Add the `@velajs/cloudflare/queues` subpath with `cloudflareQueues()`, the Cloudflare Queues driver for `QueueModule`. Configure it once with `QueueModule.forRoot({ driver: cloudflareQueues() })` and register each queue where it is used with `QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' })`. Each application gets its own driver, which reads the registered binding from that application's `ENV` when a job is added, checks that it has `send()`, and awaits the native send. `QueueClient.addBulk` uses `sendBatch`, split into calls of at most 100 messages and an estimated 256 KB; a job estimated over 128 KB is rejected before anything is sent, and a partial failure rejects with a `QueueBatchError` listing the accepted job ids.
  
  Native delivery needs no mapping: the Worker's `queue()` handler gives batches that no `@QueueConsumer` claims to `QueueModule`, which routes every job by its logical `queue`, so several registered queues can share one physical queue. Every job goes through the module's dispatch policy, so signed dispatch re-enters the signed route and runs its global guards. A message that is not a job envelope, belongs to an unregistered queue, or fails stays unacknowledged, so Cloudflare retries it and then dead-letters it. `registerQueue({ name, consumer })` pins the queue to that physical queue: its jobs are accepted only from it, and it carries only the queues pinned to it. Bootstrap rejects a physical queue claimed by both `@QueueConsumer` and a pinned registration. A raw `@QueueConsumer` owns its physical queue and must not carry jobs of queues registered with `QueueModule`, which `cloudflareQueues()` delivers: when it receives such job envelopes, which reach their `@Processor` only if the raw handler dispatches them itself, the adapter warns once per physical and logical queue unless diagnostics are silent; the raw consumer still receives and settles the batch.
  
  **Behavior change:** `cloudflareQueueDriver(bindings, { consumers, producerBindings })` and the `@velajs/cloudflare/queue` subpath are removed, together with the `CloudflareQueueBindings` and `CloudflareQueueDriverOptions` types. Replace `driver: cloudflareQueueDriver({ email: env.EMAIL_QUEUE }, { producerBindings: { email: 'EMAIL_QUEUE' } })` with `driver: cloudflareQueues()` plus `QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' })`, and replace a `consumers: { 'email-production': 'email' }` mapping with `QueueModule.registerQueue({ name: 'email', consumer: 'email-production' })`, or with a plain `registerQueue({ name: 'email' })` when the physical queue needs no pin.
  
  **Behavior change:** `consumeQueueBatch` moves to `@velajs/cloudflare/queues`. It accepts every job envelope by default instead of requiring the job's queue to equal the batch's physical queue; its `queue` option is replaced by `queues`, the list of logical queues to accept.
  
  **Behavior change:** the driver publishes one `cf:queue:module` entrypoint per application with `{ consumers }` (the pinned physical queues) instead of one `{ queueName, logicalQueue }` entrypoint per mapping, and the `cf:queue:producer` entrypoint kind is removed: registered queues are published as `queue:registration` entrypoints by `QueueModule`.
  
  **Behavior change:** a failure on the native `QueueModule` path is reported once to the exception handler instead of once by its processor and again, with the whole batch rejection, by the adapter; a message that is not a job envelope or belongs to an unregistered queue is still reported once, individually.
- 8a3016c: **Behavior change:** Workers and Durable Objects are built from static roots only. `createCloudflareWorker`, `createCloudflareApp` and `VelaWebSocketDurableObject` take a module class or a `DynamicModule` declared at module scope; `CloudflareRoot` is now `Type | DynamicModule`. The `{ create(env) }` and async `{ create: async (env) => ... }` roots are removed, with no alias, together with the per-(root, environment) resolution cache. Read bindings where each application is built instead: `Module.forRootAsync({ inject: [ENV], useFactory: (env) => ({ ... }) })`, `useFactory` providers that inject `ENV`, or `@InjectEnv()` constructors. These run for each application, so nothing built from one environment is shared with another, and constructing another application or Durable Object instance declares no new classes in the isolate. The per-environment application cache of `createCloudflareWorker` is unchanged.
  
  WebSocket upgrade routes authenticate with the gateway's `authenticator`, resolved once per application from the module that declares the gateway, and read an `(env) => origins` allowlist from the Worker's `ENV`. Authentication still completes before the Durable Object id is derived, and client-supplied `x-vela-*` headers are still stripped first. `UpgradeAuthenticator`, `WebSocketUpgradeIdentity` and `WebSocketUpgradeAuthenticationContext` are re-exported from the package root.
  
  `WsGatewayRoute` gains an optional `moduleId`: the module that declares the gateway, from which its authenticator resolves.
- 864735d: **Behavior change:** a WebSocket Durable Object now refuses to start when its module registers the core `WebSocketModule` instead of `CloudflareWebSocketModule`. The core module's `WS_SERVER` broadcasts through its own sync driver, which never reaches the Durable Object's sockets, so `@WebSocketServer()` pushes were silently lost. Import `CloudflareWebSocketModule.forRoot()` in modules a `VelaWebSocketDurableObject` bootstraps.
  
  The Worker adapter now warns once per isolate when `LiveModule` runs the default `localLive()` driver in the Worker, whose invalidations never reach subscriptions held by the Durable Object. Pass `driver: () => durableObjectLive({ namespace, gatewayPath })`. The warning respects the `'silent'` diagnostics mode.

### Patch Changes

- a01273b: A queue batch that no consumer claims now rejects with guidance: the error names the physical queue, points to `@QueueConsumer(name)` or `QueueModule.forRoot({ driver: cloudflareQueues() })` with a `QueueModule.registerQueue()` for each queue the batch carries, and states that the unacknowledged batch is retried and then dead-lettered by Cloudflare.
- e4f2008: A Durable Object WebSocket whose `handleConnection` hook broadcasts to its room, for example `server.emit('system', { text: 'joined' })`, is now admitted. The broadcast reached the still-pending socket and rejected it, so every such upgrade failed with "Unable to persist authorized WebSocket state". Broadcasts now skip a socket while its connection hook runs and deliver to the room's active sockets; a pending socket that is not being admitted is still closed with 1008. When a socket is rejected while its hook runs, the error now says so.
- Updated dependencies [07d1713]
- Updated dependencies [db18d3a]
- Updated dependencies [07d1713]
- Updated dependencies [4071cb7]
- Updated dependencies [bacaacd]
- Updated dependencies [a814199]
- Updated dependencies [1838474]
- Updated dependencies [8a3016c]
- Updated dependencies [d803a49]
- Updated dependencies [b235935]
- Updated dependencies [08a81c8]
- Updated dependencies [5b5b81d]
- Updated dependencies [7daf4fc]
- Updated dependencies [35e8e0d]
- Updated dependencies [4420501]
- Updated dependencies [ff44b6a]
- Updated dependencies [6d4f0c0]
- Updated dependencies [e3bda2a]
- Updated dependencies [bd7e3c9]
- Updated dependencies [2b74880]
- Updated dependencies [5ba8635]
- Updated dependencies [db0c834]
- Updated dependencies [d6f6a65]
- Updated dependencies [8a3016c]
- Updated dependencies [d5a3ec8]
- Updated dependencies [0f7e8e7]
- Updated dependencies [41ec70d]
- Updated dependencies [b265297]
- Updated dependencies [bdfff47]
- Updated dependencies [28c7d07]
- Updated dependencies [8a3016c]
- Updated dependencies [44efdde]
  - @velajs/vela@1.29.0
  - @velajs/feature-flags@1.29.0

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

### Patch Changes

- Updated dependencies
  - @velajs/feature-flags@1.28.0
  - @velajs/vela@1.28.0

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
