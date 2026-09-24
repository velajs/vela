# @velajs/cli

## 1.30.0

### Minor Changes

- 4d0342b: Build on the tiered `@velajs/vela` entry points: module-author seams such as `Container`, `MetadataRegistry`, `DiscoveryService`, `PipelineRunner`, trusted request identity and entrypoint scopes come from `@velajs/vela/module-kit`, and features from their subpaths. The package's own exports are unchanged.
  
  **Behavior change:** this release requires the `@velajs/vela` release that introduces `@velajs/vela/module-kit` and the feature subpaths; upgrade both together. Application code that imported these framework names from the root moves them as follows (the `@velajs/vela` changelog lists every name):
  
  | Old import | New import | Examples |
  |---|---|---|
  | `@velajs/vela` | `@velajs/vela/module-kit` | `Container`, `MetadataRegistry`, `DiscoveryService`, `createDiscoverableDecorator`, `registerEntrypointKind`, `runInEntrypointScope`, `PipelineRunner`, `RuntimeAdapter`, `invokeScheduledJob`, `getRequestContainer`, `setTrustedRequestIdentity`, `resolveErrorReporter`, `lazyProvider`, `stableHash`, `defineMetadata` |
  | `@velajs/vela` | `@velajs/vela/cache`, `/throttler`, `/schedule`, `/events`, `/health`, `/logging`, `/http-client` | `CacheModule`, `ResponseCacheModule`, `ThrottlerModule`, `ScheduleModule`, `Cron`, `EventEmitterModule`, `HealthModule`, `LoggingModule`, `HttpModule` |
  | `@velajs/vela` | `@velajs/vela/openapi` | `Endpoint`, `defineEndpoint`, `createOpenApiDocument`, `ApiDoc`, `ApiTags`, `ApiResponse` |
  | `@velajs/vela` | `@velajs/vela/security`, `/dispatch` | `SecurityModule`, `CorsModule`, `signUrl`, `NONCE_STORE`; `InternalDispatcher`, `SignedInvocation` |
  | `@velajs/vela` | `@velajs/vela/validation`, `/websocket` | `ValidationPipe`, `defineDto`, `parseSchemaAsync`; `WebSocketGateway`, `WebSocketModule` |
  | `@velajs/vela/internal` | `@velajs/vela/module-kit` | `Container`, `MetadataRegistry` |

### Patch Changes

- Updated dependencies [4467619]
- Updated dependencies [7372d90]
- Updated dependencies [c101033]
- Updated dependencies [4d0342b]
  - @velajs/vela@1.30.0

## 1.29.0

### Minor Changes

- c8d2940: `vela deploy check` checks queues registered with `QueueModule.registerQueue()`. Wrangler `queues.producers` rows now map each binding to its physical queue. Every registered `binding` must be a producer binding of the selected environment (`missing-queue-producer`). When the application consumes natively through `cloudflareQueues()`, each `@Processor` queue must be registered (`unregistered-queue-processor`) and must have a `queues.consumers` entry for the physical queues its registration pins with `consumer`, or else for its binding's producer queue (`missing-queue-consumer`). A processed queue with neither fails with `queue-processor-without-consumer` when the environment consumes no other queue, and otherwise produces an `unverified-queue-consumer` warning. A consumer that no `@QueueConsumer` or processed queue expects fails with `unhandled-queue-consumer`.
  
  **Behavior change:** snapshots listing the removed `cf:queue:producer` kind, or a `cf:queue:module` row with the removed `{ queueName, logicalQueue }` mapping, fail with `stale-entrypoint-snapshot`; regenerate them with `vela entrypoint list --json`. A `cf:queue:module` row no longer counts as a handler for its own physical queue: module consumers are derived from `queue:registration` and `queue` rows.
  
  **Behavior change:** a physical queue claimed by a `@QueueConsumer` that a registration pins with `consumer`, or that any registered queue's producer binding sends to, whether or not the Worker processes that queue, fails with `queue-consumer-claimed-by-raw`, because the raw consumer takes its batches whole and the registered jobs sent there never reach their `@Processor`. An unpinned registered queue whose producer binding sends to a physical queue pinned by other registrations fails with `queue-sent-to-pinned-queue`, because the module consumer rejects its jobs there and Cloudflare dead-letters them. A registration with both a `binding` and `consumer` pins whose producer binding sends to a physical queue outside its pins fails with `queue-producer-outside-pins`, for the same reason; this applies to a producer-only Worker that shares the registration too.
- 0327fb9: **Behavior change:** `vela deploy check` checks Workers cron jobs only through `schedule:cron` rows. A snapshot that lists the removed `cf:scheduled` or `cf:vela-cron` kinds fails with `stale-entrypoint-snapshot` instead of counting them: entrypoint snapshots made by older CLIs must be regenerated with `vela entrypoint list --json`.
  
  **Behavior change:** a `schedule:cron` row without a `dialect` whose weekday field has digits or whose day-of-month and weekday fields are both restricted (for example `0 9 * * 1` or `0 9 1 * MON`) fails with `ambiguous-cron-dialect`: Workers read the trigger with Cloudflare semantics while Node reads it with Vela's unix dialect, so the job fires on different days. Declare `{ dialect: 'cloudflare' }` on the `@Cron`; `{ dialect: 'unix' }` is only for Node-only jobs, which are not deployed as Workers.
  
  **Behavior change:** `vela entrypoint list` adds `guards: true` to the metadata of a `schedule:cron` or `schedule:interval` row whose job declares `@UseGuards` on its class, method or module, and `dispatch: 'signed'` to every scheduled row when `ScheduleModule.forRoot({ dispatch: { kind: 'signed' } })` is configured. `vela deploy check` fails a `schedule:cron` row marked `guards: true` without `dispatch: 'signed'` with `scheduled-job-guards`: guards do not run for directly dispatched scheduled jobs, so the Worker refuses to run the job on every trigger. Use signed dispatch or remove the guard, and regenerate the snapshot.
- 4a166ac: **Behavior change:** `vela new` generates a Worker entry that is only `export default createCloudflareWorker(AppModule)`, with no hand-written environment `InjectionToken`: providers read bindings, variables and secrets through the framework `ENV` (`@InjectEnv()` or `inject: [ENV]`). Generated projects add a `types` script, `wrangler types --include-runtime=false`, which also runs before `dev`, and commit its `worker-configuration.d.ts` so `VelaEnv` carries the bindings declared in `wrangler.jsonc`. They pin `@velajs/vela` and `@velajs/cloudflare` releases that provide `ENV`.
- a07f491: **Behavior change:** when the project installs Vite 8, `loadConfig()` and every command that reads `vela.config.{js,mjs,ts}` load the config, and the relative files it imports, through a Vite module runner with Oxc legacy decorators and decorator metadata; packages still load from `node_modules`, and neither the project's Vite config nor tsconfig path aliases apply. A config can therefore import decorated TypeScript source directly, at the top level or lazily from `createApp()` (`await import('./src/app.module.js')`): the runner stays open for the whole command and closes after the app is disposed. `vite` is a new optional peer dependency. Without it, Node imports the config as before, and the load error now explains how to install Vite or import compiled `.js` files.
  
  **Behavior change:** `loadConfig()` now resolves to `{ config, path, dispose }` (the new `LoadedVelaConfig` type) instead of the config itself. Call `config.createApp()` as before, then `await dispose()` once the app is disposed to close the module runner that loaded the config.
- a07f491: **Behavior change:** `vela new` generates a Vite 8 project instead of an SWC precompile. `pnpm dev` runs `vite dev` (Vite's port, 5173), `pnpm build` runs `vite build`, `pnpm preview` serves the build, and `pnpm run deploy` runs `vite build && wrangler deploy`, all through `@cloudflare/vite-plugin`. Vite's Oxc transformer emits the legacy decorators and `design:paramtypes` metadata that constructor injection needs, from options stated once in `oxc.config.ts` and imported by both `vite.config.ts` and `vitest.config.ts`. `wrangler.jsonc` points `main` at `src/worker.ts`, drops the `build` block, and sets no compatibility flags: its compatibility date enables Node.js compatibility, including `node:async_hooks`, by default. The `.swcrc` file, the `@swc/*` dependencies and the lint suppression in `src/app.controller.ts` are gone, and `tsconfig.json` (which keeps `verbatimModuleSyntax` and `isolatedModules`, since Oxc compiles one file at a time) also checks the tests and config files.
  
  Generated projects now include `test/worker.spec.ts`, which `pnpm test` runs inside workerd with `@cloudflare/vitest-plugin`; it calls the Worker's `fetch` handler and reads the body before waiting on the execution context. They pin `@velajs/cli` as a dev dependency, so `pnpm vela route list` works without a separate install, and their `vela.config.ts` imports the decorated `src/` files instead of a `dist/` build. The committed `worker-configuration.d.ts` lets a fresh checkout typecheck; `pnpm dev` and `pnpm typecheck` regenerate it first (the Wrangler file has no `build` block, so `wrangler types` runs no build), and `pnpm types` regenerates it on demand.
  
  **Behavior change:** for a project the Cloudflare Vite plugin builds, one with the `.wrangler/deploy/config.json` redirect a Vite build writes or a `vite.config.*` beside the Wrangler file that references `@cloudflare/vite-plugin`, `vela deploy check` suggests `cd '<dir>' && CLOUDFLARE_ENV=<env> pnpm build && pnpm exec wrangler deploy --env <env> --dry-run` as its next step, and its `--json` report adds the build as `nextStep.build` (`{ command, args, env, cwd }`). It previously suggested `wrangler deploy --config <file> --env <name> --dry-run`, which bypasses the Vite build and bundles the source with esbuild, without decorator metadata. Wrangler checks the kept `--env` against the environment the build targeted. Checking a Wrangler file with another name than `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` adds a `vite-config-path` warning, since the plugin reads those unless its `configPath` option names the file. Other projects keep the `--config` suggestion. Every next step now runs in the Wrangler file's directory: the printed command starts with `cd '<dir>' &&`, and the JSON steps carry it as `cwd`, so a check run from a parent directory suggests commands that resolve the project's own scripts and Wrangler.

### Patch Changes

- 53e8f43: `vela client generate` no longer fails with `OpenAPI is missing ALL ...` on an application with an `@All` route, such as the Better Auth catch-all handler. OpenAPI has no operation for `ALL`, so the check that the document covers every application route now skips those routes, as the document itself does.
- Updated dependencies [07d1713]
- Updated dependencies [db18d3a]
- Updated dependencies [07d1713]
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

### Minor Changes

- b99d71a: Compose native Worker applications through modules. QueueModule now initializes transport configuration at bootstrap and publishes driver-owned native routes, removing application-written consumer bridges. Duplicate queue ownership fails at startup. Cloudflare rejects deliveries without a consumer instead of silently accepting them; existing native decorators and envelopes remain supported.
  
  Cloudflare roots accept dynamic modules and asynchronous factories. RPC server modules and injectable named clients reuse the existing schema-validated dispatcher. Deployment checks validate module queue mappings, producer declarations and RPC service bindings. A four-worker example and exact-archive runtime proof cover composition, native delivery and scheduling.

### Patch Changes

- Updated dependencies [b99d71a]
  - @velajs/vela@2.0.0

## 1.26.1

### Patch Changes

- 7f7b421: Update generated Worker projects to core 1.27.0 and Cloudflare 1.24.0 so new applications use the current framework APIs and execution lifetimes. Keep exact dependency pins and install generated projects from the public npm registry.

## 1.26.0

### Minor Changes

- 2addbe3: Add binary, streaming and native Response endpoint contracts with explicit media types and OpenAPI metadata. Native responses preserve their status, headers and body; stream handling retains backpressure, cancellation and producer errors without buffering.
  
  Generate native HTTP client contracts with unknown JSON results and add response, blob and stream consumption helpers. Existing JSON/text responses and multipart/URL-encoded request contracts retain their behavior.

### Patch Changes

- Updated dependencies [2addbe3]
- Updated dependencies [2addbe3]
- Updated dependencies [2addbe3]
  - @velajs/vela@1.27.0

## 1.25.0

### Minor Changes

- 4a6f5df: Add schema-bound multipart and URL-encoded endpoint bodies with native files,
  repeated fields, explicit bounded parsing, and matching OpenAPI contracts. Generate
  accurate form request types and encoding metadata, with an opt-in HTTP fetch adapter
  that preserves caller transports and request options. Existing JSON endpoints and
  Hono client exports remain compatible.

### Patch Changes

- Updated dependencies [efdf854]
- Updated dependencies [4a6f5df]
  - @velajs/vela@1.26.0

## 1.24.0

### Minor Changes

- 2c1cac6: Add read-only `vela doctor` config provenance and opt-in application snapshots.
  Validate imported configs and Studio ports and preserve inferred config subtypes.
  Generate a Node-side config
  that imports the starter's SWC output, and explain the decorator/compiler boundary.
- 50358a1: Add read-only `vela deploy check` for explicit Wrangler environments and saved entrypoint snapshots. Validate configuration, cron and queue alignment, and WebSocket Durable Object bindings; report redacted target information and git/input provenance without constructing applications, running custom builds or uploading code.
- 4fde903: Discover seeders per owning module registration and await async resolution inside
  managed invocation scopes. Preserve sequential ordering and stop/continue behavior
  while settling deferred work before disposal. Add optional module ownership to
  seeder inventories and expose it through `vela db seed --list --json` without
  executing seeders.

### Patch Changes

- 6d33ac9: Dispose applications after seeder registry or command failures, preserving the
  primary result when cleanup fails. Share command lifetime handling across
  introspection, client generation and MCP, including cleanup of older 1.x apps
  whose shutdown hooks throw.
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

## 1.23.0

### Minor Changes

- 23c7808: Add `vela new <name>` to create a minimal Cloudflare Workers application with a module, controller, and constructor-injected service. Include published npm dependencies, TypeScript and SWC decorator configuration, Wrangler source rebuilds, pnpm scripts, and a short runnable README. Reject invalid names and nonempty destinations without overwriting files. Report the actual package version from `vela --version`.

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
  - @velajs/studio-host@1.22.0
  - @velajs/vela@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/vela@2.0.1

## 2.0.0

Schema-driven Hono client generation and the local Vela Studio host command. Generated contracts preserve unknown types where a response schema is absent.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.0.0

### Major Changes

- faef8b1: Require the Vela 1.21 runtime so generated and inspected applications use the coordinated security-boundary release.

## 0.3.2

### Patch Changes

- 1e1ec9c: Modernize the package build, validation, and release toolchain.
