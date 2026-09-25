# @velajs/studio

## 1.33.0

### Minor Changes

- b7d0725: Enforce include allowlists and strict bulk mutation filters, run point-read hooks inside the read scope, and reject D1 mutations whose read policies require interactive transactions. Require transactional row locking for ETag resources and lock before validating If-Match to prevent concurrent lost updates.
  
  Remove nonfunctional relation cascade configuration and the CRUD cascade driver. Use database foreign keys for hard-delete actions or explicit transactional hooks for soft-delete propagation. Studio's CRUD source no longer advertises a cascade preview without database constraint metadata.
  
  Remove implicit Hono context arguments, process-global Logger configuration, and the ComponentManager interceptor alias. Use explicit @Ctx(), instance-owned logging or LoggingModule, and PipelineRunner.chainInterceptors.
- b7d0725: Remove obsolete contracts and backward-compatibility paths.
  
  Validation now requires Standard Schema or DTO descriptors. Decorated events require event definitions and use EventDispatcher; EventEmitter.emit always settles every matching callback. Remove token-only discovery, instance-based schedule views, ownerless entrypoints, disposed-container reuse, unmanaged scope finalization, and the `(.*)` middleware alias. Queue driver bind returns cleanup and enqueue after inline disposal rejects. Configure HTTP body caps through security.body.maxBytes.
  
  WebSocket clients must report admission with trySendRaw. Tiered caches require expiry-aware read/write methods; KV entries without expiry metadata miss. Aggregate specs use only aggregations, the default CRUD adapter can be undefined, and Studio discovers resources registered through Crud. Remove the Studio path alias, the mail envelope argument overload, the AI embedding resolver fallback, and the obsolete contentHash export.
  
  Storage encryption rejects invalid ciphertext; compression requires format metadata and a metadata-capable store.
  
  Update adapters, examples, tests, API snapshots and migration documentation to the current contracts.

### Patch Changes

- Updated dependencies [b7d0725]
- Updated dependencies [b7d0725]
  - @velajs/vela@1.33.0
  - @velajs/crud@1.33.0
  - @velajs/cloudflare@1.33.0
  - @velajs/better-auth@1.31.0
  - @velajs/feature-flags@1.31.0

## 1.32.0

### Minor Changes

- ff98301: Module descriptions name their visibility flag `global`, as `ModuleMetadata` (`@Global()`) and `DynamicModule` do.
  
  **Behavior change:** `ModuleDescription.isGlobal` (from `Container.getModuleDescriptions()`, `@velajs/vela/module-kit`) is removed; read `ModuleDescription.global`. The internal `ModuleScope.isGlobal` passed to `Container.registerScope()` (`@velajs/vela/internal`) is renamed `global` too. `vela module graph --json` and the `vela mcp serve` `module_graph`/`token_describe` results report `global` instead of `isGlobal`. The Studio wire protocol moves to version 4 (`STUDIO_PROTOCOL_VERSION`): `app.modules` rows carry `global` instead of `isGlobal` (`ModuleNode.global` in `@velajs/studio-protocol`), so upgrade `@velajs/studio`, `@velajs/studio-host` and `@velajs/studio-ui` together (a host or UI on protocol 3 refuses a protocol-4 application, and the reverse). Studio and CLI 1.31.0 read `isGlobal` and accept core 1.32.0 through their `^1.31.0` peer ranges without a warning: the CLI then reports no module as global, and Studio sends module rows without the `isGlobal` field its protocol-3 UI requires, so upgrade `@velajs/cli` and `@velajs/studio` to 1.32.0 with the core. The `isGlobal` registration extra of `forRoot()` options is unchanged.
- e412fc8: Studio and its panels read the framework tokens `ENV`, `APP_LOGGER`, `ROOT_MODULE`, `Container`, `DiscoveryService` and `EntrypointRegistry` from the application, application-wide as `app.get()` does. They injected them in StudioModule's scope, which plugin providers and the modules plugins import join, so a plugin's provider, or an export of a module a plugin imported, answered before the application's registration: Studio read the panel's `ENV` (its admin token among it), described another root module or inspected another container, while `app.get()` returned the application's. That included a module another plugin's import had already loaded with those exports and a `@Global()` module nested inside a plugin import exporting `ENV` while the application seeded one.
  
  Studio reads the `ENV` the runtime seeds (`@velajs/cloudflare`, `VelaFactory.create(App, { env })`), else the one a `@Global()` module exports to every module. An `ENV` a module registers for itself or exports to its importers only is not the application's and leaves Studio closed, as does a `@Global()` module listing `ENV` among its exports without providing it or importing a module that exports one.
  
  **Behavior change:** `StudioModule.forRoot({ plugins })` and `forRootAsync` fail, naming the plugin and the token, when a plugin provides one of these tokens: in Studio's scope it would answer first for the panels' providers, and where the application registers none (no `LoggingModule`, no seeded `ENV`) application-wide lookups would return it. Previously the plugin's provider silently replaced the application's inside Studio. Provide these tokens in the application, not in a panel. A plugin's imports are not checked: what they export to their importers never answers for Studio when the application registers the token. Where it registers none, such as `APP_LOGGER` without `LoggingModule` or an `ENV` neither seeded nor exported by a `@Global()` module, Studio's lookups fall back to another module's registration exactly as `app.get()` does; Studio's own `VELA_STUDIO_*` settings never read such an `ENV`. An explicit application registration, such as a seeded `ENV`, answers first; a `@Global()` module exporting `ROOT_MODULE` or `DiscoveryService`, one a plugin imports included, overrides that framework default for the whole application, for `app.get()` and Studio alike. An application with Studio now fails to boot when a `@Global()` module exports a `Container` other than the application's; Studio used that container and read its `ENV` and admin token. Remove that export. A custom panel's provider that injects one of these tokens directly resolves it in Studio's scope, where every plugin's imports are visible; `moduleRef.get(TOKEN, { strict: false })` reads the application's. `StudioDispatchRegistry` resolves `DiscoveryService` from the application, so its constructor no longer takes one.

### Patch Changes

- 77f36c9: The admin routes and `studioRuntimeAdapter` read Studio's own `STUDIO_RESOLVED_CONFIG`, `AdminSubTokenSigner`, `StudioDispatchRegistry` and `StudioAppHolder` in StudioModule's scope. They looked them up application-wide, where a module registering one of them without exporting it answered when it loaded before StudioModule, as a module a plugin imports does: the admin surface then accepted that module's token, minted sub-tokens with its signer and filled its route holder.
- Updated dependencies [9dea818]
- Updated dependencies [524e422]
- Updated dependencies [0dccc7f]
- Updated dependencies [8f3d0a6]
- Updated dependencies [b4494a3]
- Updated dependencies [ef18e04]
- Updated dependencies [a7d0912]
- Updated dependencies [04e7ac5]
- Updated dependencies [ff98301]
- Updated dependencies [38ab1e5]
- Updated dependencies [1522c33]
- Updated dependencies [38ab1e5]
- Updated dependencies [9c1bd0b]
- Updated dependencies [e412fc8]
- Updated dependencies [bcdf5e3]
- Updated dependencies [d5a8c60]
  - @velajs/vela@1.32.0
  - @velajs/cloudflare@1.32.0
  - @velajs/crud@1.32.0
  - @velajs/studio-protocol@1.25.0
  - @velajs/better-auth@1.31.0
  - @velajs/feature-flags@1.31.0

## 1.31.0

### Minor Changes

- 646f1d1: Studio panels join through one plugin contract: `StudioModule.forRoot({ plugins: [queuesPanel(), livePanel(), ...] })`. A plugin (`StudioPlugin`: `name`, `providers`, `imports`; built with `defineStudioPlugin`) registers its op classes and ports in StudioModule's own scope, so they reach Studio's signers, buffers and resolved configuration without re-importing the configured module. Each panel factory lives in its subpath, keeping optional peers optional: `crudPanel()` (`./crud`), `timeTravelPanel()` (`./timetravel`), `cloudflareTimeTravelPanel()` (`./cloudflare`), `authPanel()` (`./auth`), `flagsPanel()` (`./flags`), `queuesPanel()` (`./queue`), `schedulePanel()` (`./schedule`), `livePanel()` (`./live`) and `logsPanel()` (`./logging`). `plugins` is structural, so `forRootAsync({ plugins, useFactory })` takes it next to the factory; a plugin name registered twice fails at `forRoot`, and so do two plugins providing the same token (such as `timeTravelPanel()` and `cloudflareTimeTravelPanel()`, which both bind `TIME_TRAVEL_PORT`), naming both, and a plugin providing a token StudioModule provides itself (`STUDIO_RESOLVED_CONFIG`, `AdminAuditLog`, the signers, the op classes, …), naming the plugin; application-wide enhancers (`APP_GUARD`, `APP_INTERCEPTOR`, ...) may repeat. `livePanel({ rooms: ['default'] })` reads the named rooms through `LiveModule`'s `LiveInspector`, so a Cloudflare application no longer builds a Studio source from `ENV` and Durable Object stubs; it fails at bootstrap without `LiveModule`, and `livePanel({ source })` takes a custom source instead (passing both is rejected). Options that depend on the runtime environment take a function of the application's `ENV`, called once per application: `livePanel({ source: (env) => … })`, `timeTravelPanel({ store: (env) => …, changeSource: (env) => … })`. `cloudflareTimeTravelPanel({ binding: 'ROOM' })` names its Durable Object binding and resolves it from `ENV` when a time-travel call first needs it, failing with the binding and `durable_objects.bindings` when it is missing. `logsPanel()` captures the application's `APP_LOGGER` and fails bootstrap naming `LoggingModule` when there is none. StudioModule stays one instance per application whatever its panels: a second configuration with other plugins fails bootstrap instead of mounting a second admin surface. The wire protocol is unchanged, so the protocol version stays the same; the admin surface stays closed without a token.
  
  **Behavior change:** the per-feature modules are removed: `StudioCrudModule`, `StudioTimeTravelModule` (with `STUDIO_TIMETRAVEL_MODULE_OPTIONS` and `StudioTimeTravelModuleOptions`), `StudioCloudflareTimeTravelModule` (with `STUDIO_CLOUDFLARE_TIMETRAVEL_MODULE_OPTIONS` and its options type), `StudioAuthModule`, `StudioFlagsModule`, `StudioQueueModule`, `StudioScheduleModule`, `StudioLiveModule` and `StudioLoggingModule`, with their options types and the `STUDIO_*_MODULE_ID` constants. Replace each `StudioXModule.forRoot(options)` import with its panel in `StudioModule.forRoot({ plugins })`; the time-travel, Cloudflare and logging panels no longer need `imports: [studio, …]`. `StudioLiveModule.forRoot({ source })` becomes `livePanel({ source })` (or `livePanel({ rooms })`, which reads the rooms through `LiveInspector` without a custom source), `StudioLiveModule.forRootAsync({ inject: [ENV], useFactory: (env) => ({ source }) })` becomes `livePanel({ source: (env) => source })`, and `StudioCloudflareTimeTravelModule.forRoot({ namespace: env.ROOM })` becomes `cloudflareTimeTravelPanel({ binding: 'ROOM' })`.
  
  **Behavior change:** the data browser's settings move from `StudioModule` to its panel: `StudioModule.forRoot({ managedModels, runAsIdentity })` becomes `crudPanel({ managedModels, runAsIdentity })`, and `ResolvedStudioConfig` no longer carries them. StudioModule options that still hold either key, such as a `forRootAsync` factory result the compiler does not check or options passed from JavaScript, fail bootstrap (and `resolveStudioConfig`) with an error pointing to `crudPanel()`, instead of being ignored with every model browsable. A custom model-source panel provides `STUDIO_DATA_OPTIONS` (`StudioDataOptions`) for the same settings.
- 3fc6f2b: Studio's OpenAPI view builds its document with the application's route-path options (`app.getRoutePathOptions()`), so its paths match the served routes, including routes a global prefix's `exclude` serves unprefixed, `VERSION_NEUTRAL` routes and a custom versioning `prefix`.
  
  **Behavior change:** `StudioAppHolder.capture(app, routePathOptions)` takes the application's `RoutePathOptions` instead of the global prefix string, and the new `routePathOptions` getter returns them; `globalPrefix` still returns the prefix.

### Patch Changes

- 3fc6f2b: Studio names the source of a reported error with `ExecutionContext.getHandlerName()`, because `getHandler()` returns the handler method from @velajs/vela 1.31.0.
- Updated dependencies [5f19b37]
- Updated dependencies [0b8c649]
- Updated dependencies [b227d22]
- Updated dependencies [3fc6f2b]
- Updated dependencies [1011653]
- Updated dependencies [2c92243]
- Updated dependencies [088f4d4]
- Updated dependencies [e2587de]
- Updated dependencies [37dd27d]
- Updated dependencies [f267c2f]
- Updated dependencies [dfe925c]
- Updated dependencies [b227d22]
- Updated dependencies [fd11d20]
- Updated dependencies [748e4f8]
- Updated dependencies [096e259]
- Updated dependencies [fd11d20]
- Updated dependencies [3418c55]
- Updated dependencies [b227d22]
- Updated dependencies [fd11d20]
- Updated dependencies [d51dbb3]
- Updated dependencies [f267c2f]
- Updated dependencies [4a06057]
- Updated dependencies [f267c2f]
- Updated dependencies [1bfc1c1]
- Updated dependencies [f267c2f]
- Updated dependencies [f267c2f]
- Updated dependencies [1ef55ac]
- Updated dependencies [f267c2f]
- Updated dependencies [b227d22]
- Updated dependencies [2c92243]
  - @velajs/cloudflare@1.31.0
  - @velajs/vela@1.31.0
  - @velajs/better-auth@1.31.0
  - @velajs/crud@1.31.0
  - @velajs/feature-flags@1.31.0

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

- Updated dependencies [44023fc]
- Updated dependencies [4d0342b]
- Updated dependencies [4467619]
- Updated dependencies [7372d90]
- Updated dependencies [c101033]
- Updated dependencies [4d0342b]
  - @velajs/cloudflare@1.30.0
  - @velajs/better-auth@1.30.0
  - @velajs/crud@1.30.0
  - @velajs/feature-flags@1.30.0
  - @velajs/vela@1.30.0

## 1.29.0

### Minor Changes

- 41ec70d: Name the default provider lifetime `Scope.DEFAULT`, as Nest does.
  
  **Behavior change:** Scope.SINGLETON is renamed Scope.DEFAULT (Nest naming); no alias. Replace every `Scope.SINGLETON` with `Scope.DEFAULT`. The member's runtime value changes from `'singleton'` to `'default'`, so `getScope`, `Container.getProviderScope`, `Container.getResolvedScope`, `DiscoveryService` registrations and the conflicting-scope decorator error now report `default`. Code that compares a scope against the string `'singleton'` must compare against `Scope.DEFAULT` instead.
  
  **Behavior change:** Studio's `app.modules` provider scopes and `app.entrypoints` scopes label that lifetime `default` instead of `singleton`. `StudioProviderScope` is now `'default' | 'transient' | 'request'`, and the response validators reject `singleton`. Because an op's payload changed, `STUDIO_PROTOCOL_VERSION` is now 3 and `StudioConnection.protocolVersion` is typed as that constant. The Studio UI rejects a health probe or host connection that reports another version with its protocol-mismatch error instead of failing on the first scope label, so upgrade `@velajs/vela`, `@velajs/studio`, `@velajs/studio-ui` and `@velajs/studio-host` together.
- d4610ac: **Behavior change:** Studio reads its `VELA_STUDIO_*` variables and secrets from the application's `ENV`, when a runtime seeded one, instead of `CONFIG_ENV`. On Workers, a `VELA_STUDIO_TOKEN` secret (and the `VELA_STUDIO_*_EDITABLE` flags) now takes effect automatically, because `@velajs/cloudflare` seeds the Worker environment as ENV; before, it was never read there. Module options still override environment values, non-string values are ignored, and Studio stays closed when no token is configured.
  
  **Behavior change:** the `studioConfig` namespace export is removed, with no alias. Use `readStudioEnv(env)` to parse the `VELA_STUDIO_*` values of an environment into a `StudioEnvConfig`, and `resolveStudioConfig(envConfig, options)` to merge them under module options.
- a814199: Read admin RPC and `/ws-token` request bodies with `readJsonBody` from `@velajs/vela`.
  
  **Behavior change:** admin RPC and `/ws-token` requests whose body is not sent as
  `application/json` (or a `+json` media type) are refused with a 415 `unsupported_media_type`
  error envelope instead of being parsed as JSON, so a cross-site form or `text/plain` POST never
  reaches an admin operation. Requests without a body are dispatched as before. Custom Studio
  clients must send `content-type: application/json`.
- ddb823c: The queues panel lists every queue the application registers with `QueueModule.registerQueue()`, in union with the queues its `@Processor` providers handle, so a producer-only queue appears too. `queue.send` enqueues through the registered queue's client.
  
  **Behavior change:** apps that mount `StudioQueueModule` configure queues with `QueueModule.forRoot()` plus `QueueModule.registerQueue({ name })` instead of `QueueModule.forRoot({ queues: [name] })`, which no longer exists. `queue.list` now includes registered queues without a processor.
- 8a3016c: **Behavior change:** `app.openapi` and the `openapi` capability document the application's root module by default. Studio reads the core `ROOT_MODULE` token when its options name no `rootModule`, so an application no longer hands its root back to Studio, for example through a `forRootAsync` self-reference. `rootModule` still narrows the document to one module and accepts a `DynamicModule`. `resolveStudioConfig(env, options, applicationRoot?)` takes the application root as an optional third argument.
- d448f3d: **Behavior change:** `schedule.runNow` runs the job through `invokeScheduledJob`, the primitive timers and cron triggers use. The job receives a `ScheduleInvocation` (with `scheduledTime` set to the time of the run) instead of no arguments, runs in a fresh invocation scope so request-scoped jobs can be run, and re-enters its signed route when the application uses signed `ScheduleModule` dispatch. Interval jobs can be run too. What a native trigger seeds into the job's scope comes from the runtime's `SCHEDULE_INVOCATION_SEED`: on Workers the job receives a synthetic `CLOUDFLARE_SCHEDULED_EVENT` whose `noRetry()` does nothing, so a job that injects it runs instead of failing. Unlike a trigger, the run completes inside the Studio request, and a failure is returned to the caller rather than retried by the platform. A direct job that declares `@UseGuards` is refused, as it is on a trigger, instead of running unguarded. Closing the application aborts the signal of a run still in progress and waits for it.
  
  **Behavior change:** `schedule.jobs` and `schedule.triggers` list jobs from the schedule registry's metadata-only entrypoints, the same descriptors `schedule.runNow` executes, instead of its materialized instances. Request-scoped jobs (such as one that injects `CLOUDFLARE_SCHEDULED_EVENT`) and jobs in lazy modules now appear in the panel, without a "request-scoped ... skipped" warning and without being constructed.

### Patch Changes

- Updated dependencies [2dd809d]
- Updated dependencies [8a3016c]
- Updated dependencies [416650e]
- Updated dependencies [a3e2b38]
- Updated dependencies [2ae8505]
- Updated dependencies [8a3016c]
- Updated dependencies [a01273b]
- Updated dependencies [e4f2008]
- Updated dependencies [864735d]
- Updated dependencies [07d1713]
- Updated dependencies [ff44b6a]
- Updated dependencies [bacaacd]
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
- Updated dependencies [4071cb7]
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
  - @velajs/better-auth@1.29.0
  - @velajs/cloudflare@1.29.0
  - @velajs/vela@1.29.0
  - @velajs/crud@1.29.0
  - @velajs/errors@1.23.0
  - @velajs/feature-flags@1.29.0
  - @velajs/studio-protocol@1.24.0

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

### Patch Changes

- Updated dependencies
  - @velajs/better-auth@1.28.0
  - @velajs/cloudflare@1.28.0
  - @velajs/crud@1.28.0
  - @velajs/feature-flags@1.28.0
  - @velajs/vela@1.28.0

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/better-auth@3.0.0
  - @velajs/cloudflare@3.0.0
  - @velajs/crud@3.0.0
  - @velajs/feature-flags@3.0.0
  - @velajs/vela@3.0.0

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [a2d2692]
- Updated dependencies [b99d71a]
  - @velajs/better-auth@2.0.0
  - @velajs/crud@2.0.0
  - @velajs/feature-flags@2.0.0
  - @velajs/vela@2.0.0
  - @velajs/cloudflare@2.0.0

## 1.23.0

### Minor Changes

- c5d98a7: Use the shared CRUD database resolver for Studio resources, expose qualified database/resource identities, and reject ambiguous legacy names or invalid explicit selections. Keep relation inspection and generated foreign keys within the selected database. Preserve native compiled CRUD adapters and fail before writes when time-based CDC replay would require an unavailable database-aware change source.
- 8b3ba80: Add optional application-owned structured log capture and handler completion timing through `@velajs/studio/logging`. Expose additive module ownership, effective provider scopes, and invocation metadata in Studio protocol v2 and the UI. Bound and copy log snapshots, preserve older protocol responses, and document Worker/test debugger workflows.

### Patch Changes

- 7a4b7bc: Bound Studio entrypoint metadata snapshots, make bigint and cycles JSON-safe, and avoid traversing getters or live class instances. Copy route descriptions at the inspection boundary and avoid duplicate GET rows for attributed HEAD handlers.
- 9638591: Report caught admin RPC errors once through the configured application logger and exception policy, preserving invocation correlation while keeping raw error details out of the client response.
- 8f6b19e: Discover admin handlers without constructing them, reject duplicate confirmation summaries, and resolve handlers and summaries asynchronously in their owning module and invocation scope. Preserve symbol methods and private receivers while enforcing write gates before construction.
- Updated dependencies [c6a43a6]
- Updated dependencies [bbe62d4]
- Updated dependencies [a6ef933]
- Updated dependencies [dae3654]
- Updated dependencies [26fe8bf]
- Updated dependencies [77cca9e]
- Updated dependencies [b9f75f5]
- Updated dependencies [df47ea8]
- Updated dependencies [af019bf]
- Updated dependencies [6df1059]
- Updated dependencies [bdd90a1]
- Updated dependencies [8a3923f]
- Updated dependencies [c7d108b]
- Updated dependencies [6588211]
- Updated dependencies [1c7f635]
- Updated dependencies [636ffbc]
- Updated dependencies [54f8864]
- Updated dependencies [f49db45]
- Updated dependencies [a66a3cb]
- Updated dependencies [4fde903]
- Updated dependencies [6a1b5b3]
- Updated dependencies [a95951a]
- Updated dependencies [9e82187]
- Updated dependencies [c5a3cb0]
- Updated dependencies [363fb71]
- Updated dependencies [de4e57e]
- Updated dependencies [c5d98a7]
- Updated dependencies [8b3ba80]
- Updated dependencies [0765aaa]
- Updated dependencies [cc0dcfd]
- Updated dependencies [6b7cf23]
- Updated dependencies [5205e58]
- Updated dependencies [ae45689]
  - @velajs/vela@1.25.0
  - @velajs/cloudflare@1.23.0
  - @velajs/crud@1.25.0
  - @velajs/better-auth@1.22.2
  - @velajs/studio-protocol@1.23.0
  - @velajs/feature-flags@1.22.1

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/better-auth@1.22.1
  - @velajs/cloudflare@1.22.1
  - @velajs/crud@1.22.1
  - @velajs/errors@1.22.1
  - @velajs/feature-flags@1.22.1
  - @velajs/studio-protocol@1.22.1
  - @velajs/vela@1.22.1

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/better-auth@1.22.0
  - @velajs/cloudflare@1.22.0
  - @velajs/crud@1.22.0
  - @velajs/errors@1.22.0
  - @velajs/feature-flags@1.22.0
  - @velajs/studio-protocol@1.22.0
  - @velajs/vela@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/vela@2.0.1
  - @velajs/errors@2.0.1
  - @velajs/better-auth@2.0.1
  - @velajs/cloudflare@2.0.1
  - @velajs/feature-flags@2.0.1
  - @velajs/crud@2.0.1
  - @velajs/studio-protocol@2.0.1

## 2.0.0

Initial coordinated release: authenticated admin operations, checked wire schemas, native Worker try-it boundaries, and opt-in read-only live/presence inspection.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.
