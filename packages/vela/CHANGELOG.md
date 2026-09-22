# Changelog

## 1.27.0

### Minor Changes

- 2addbe3: Add binary, streaming and native Response endpoint contracts with explicit media types and OpenAPI metadata. Native responses preserve their status, headers and body; stream handling retains backpressure, cancellation and producer errors without buffering.
  
  Generate native HTTP client contracts with unknown JSON results and add response, blob and stream consumption helpers. Existing JSON/text responses and multipart/URL-encoded request contracts retain their behavior.
- 2addbe3: Add optional Web API tracing and metrics with no-op defaults, validated W3C trace
  propagation, explicit request-scope context, and an OpenTelemetry bridge that uses
  application-owned tracers and meters without exporter dependencies or automatic
  network activity. HTTP instrumentation records one completion through streaming,
  cancellation, deferred work, and disposal using bounded default attributes.
  Structural HTTP client and execution observers support independent integrations.
- 2addbe3: Extend the HTTP client with injectable fetch transports, composed cancellation and timeouts, streaming response byte limits, schema-inferred response validation, and optional instrumentation hooks. Preserve URL prefix and generic-call compatibility while fixing query/fragment handling, case-insensitive headers, multipart boundaries, and Web request-body forwarding.

## 1.26.0

### Minor Changes

- efdf854: Add opt-in asynchronous response caching with explicit trusted partitions, bounded JSON replay, and generic scoped generation-based invalidation. Preserve the synchronous CacheService API and provide an independent optional KV invalidation adapter with documented eventual-consistency limits. Preserve absolute expiry during tier backfill and KV physical retention, and fence fills that race with visible invalidation.
- 4a6f5df: Add schema-bound multipart and URL-encoded endpoint bodies with native files,
  repeated fields, explicit bounded parsing, and matching OpenAPI contracts. Generate
  accurate form request types and encoding metadata, with an opt-in HTTP fetch adapter
  that preserves caller transports and request options. Existing JSON endpoints and
  Hono client exports remain compatible.

## 1.25.0

### Minor Changes

- c6a43a6: Add optional application-owned structured logging with typed immutable records,
  bounded serialization, Error causes, redaction before sinks, category thresholds,
  and lifecycle-managed subscriptions and async delivery. Existing Logger and text
  Writer behavior remains unchanged. Add GraphQL and RPC exception-report contexts.

  Bind logging to existing invocation lifetimes with protected correlation fields,
  track asynchronous sink/custom-report completion, and route default exceptions
  through the configured application logger without duplicate custom reporting.
- bbe62d4: Await typed endpoint input and output schemas, retaining distinct wire input, parsed handler input, domain result and serialized output types. Generate directional OpenAPI contracts and preserve validator implementation errors as internal failures instead of mapping every exception to 400.
- dae3654: Add portable async-aware schema parsing, inferred schema input/output helpers and DTO parseAsync while preserving synchronous DTO parsing. Normalize validation issues without forwarding vendor input values or treating validator implementation failures as client input errors.
- b9f75f5: Add read-only visible provider snapshots for module-aware wiring audits. Introspection exposes provider
  kind, class/alias wiring, effective scope and existing values without running factories, constructing
  request providers or materializing lazy modules.
- 6df1059: Add `defineSerializer` to validate domain inputs, project an explicit public
  representation and validate wire outputs with inferred types, including domain
  classes with JavaScript private state. Input and output transformations retain
  their separate source and result types.
- bdd90a1: Consume once listeners before invocation, including recursive and overlapping dispatch. Add opt-in complete event settlement while preserving the existing emit policy.

  Add schema-inferred event definitions, scoped decorated dispatch and managed deferred delivery. Resolve legacy request-scoped event listeners per invocation and preserve their declaring module.
- 1c7f635: Add explicit managed execution scopes with injectable deferred-work lifetimes,
  observable completion errors, stream-boundary coordination, and owner-qualified
  asynchronous entrypoint and pipeline component resolution. Expose the existing HTTP
  execution-context builder for optional adapters. Keep HTTP request identity separate from
  non-HTTP work, and hide typed request-key storage with JavaScript private state.
- 636ffbc: Add a stable class-owner form of `sideEffectModule` for deduplicated contributions,
  and type call-site lazy controls and asynchronous structural module options while
  preserving inferred DI factory dependencies. Document selective integration
  composition and owner-aware discovery/dispatch.

  Preserve explicit undefined values in forwarded async structural-option bags for
  consumers using exactOptionalPropertyTypes.
- f49db45: Preserve module constructor/key identity in dependency cycles and OpenAPI traversal,
  initialize each owned provider registration, and carry module ownership through
  additive metadata-only discovery APIs and entrypoint records. Existing token-level
  discovery remains supported.

  Preserve the declaring module for configured middleware and controller mounts.
  Ambiguous mounts of the same controller class in different module instances now
  fail explicitly instead of selecting the first owner.
- 4fde903: Discover seeders per owning module registration and await async resolution inside
  managed invocation scopes. Preserve sequential ordering and stop/continue behavior
  while settling deferred work before disposal. Add optional module ownership to
  seeder inventories and expose it through `vela db seed --list --json` without
  executing seeders.
- 6a1b5b3: Correct queue disposition observation to retain the first successful ack/retry, count the initial delivery separately from retries, and distinguish unknown DLQ configuration. Add per-application queue driver factories, reject unsafe rebinding, and dispose inline bindings without retaining pending jobs.
- a95951a: Add explicit Unix/Cloudflare cron dialects, UTC selection and validated schedule metadata for deployment introspection. Fix Sunday-ending ranges and numeric coercion, reject invalid timer delays, and provide native scheduled handler types while preserving exact Workers trigger matching and Node local-time defaults.
- 9e82187: Resolve Node scheduled providers asynchronously inside a fresh module-owned invocation scope for each firing. Expose typed cooperative cancellation, stop timers and drain in-flight/deferred work before shutdown disposal, and observe strict diagnostic failures through application close. Keep direct method execution, singleton lifetimes, signed re-entry and legacy instance introspection compatible.
- c5a3cb0: Preserve authentication payload through verified tenant admission while retaining
  invalidation on expiry, clear and reauthentication. Add explicit HTTP-backed
  execution-context identity binding for custom dispatchers, and add a redacting
  Secret value with runtime-private signing
  credentials. Existing authentication and signing entrypoints remain compatible.
- 6b7cf23: Add Standard Schema job definitions with inferred producer input and validated processor output. Preserve original wire input across transport, await all processor outcomes, and offer opt-in strict unmatched routing. Add awaited Cloudflare producer and per-message consumer bridge helpers that validate envelopes, use native attempts, and preserve explicit ack/retry semantics.

  Preserve processor module ownership through discovery and dispatch, resolve scoped components asynchronously, and finish managed invocation work before settling delivery.
- 5205e58: Validate WebSocket correlation envelopes and hibernation attachments, preserve live baselines after refused sends, and add bounded connection-local send admission and incoming work. Existing void send APIs and unversioned 1.x attachments remain supported.

  Drop frames still waiting on Node connection setup after overload or close. Use browser-valid private close codes and reconnect after client-side send admission failures.
- ae45689: Resolve WebSocket callbacks and live queries in managed invocation scopes with module-owned async pipeline components. Preserve explicit request-scoped gateways, discover providers without requiring bootstrap instances, share live authorization and resolver state, and use asynchronous body validation without repeating transforms. Reject ambiguous gateway and live query ownership.

### Patch Changes

- a6ef933: Await output serialization for legacy async parsers and Standard Schema DTOs,
  including array items, and reject malformed serializer metadata instead of
  passing unfiltered responses through. Existing item-per-array semantics remain.
- 77cca9e: Resolve useExisting targets from the alias's declaring module after checking visibility of the alias.
  Exported aliases can reference their module's private implementation, consumer shadowing no longer
  rewires aliases, and unqualified aliases in different modules retain their respective targets.
  Aliases to another module's unexported providers remain rejected.
- df47ea8: Keep request provider instances and synchronous cycle detection isolated by module registration,
  including after provider replacement. Detect synchronous alias cycles without overflowing the stack.
  Add optional exact-owner module IDs to provider scope, lazy-state and instance diagnostics while
  preserving explicit request seeds and asynchronous construction deduplication.
- af019bf: Dispose transient providers with their retaining request or singleton graph, preserving caller-owned
  values and seeds. Wait for owned asynchronous construction before disposal, coalesce concurrent
  teardowns and prevent new resolution during teardown while retaining container reuse after disposal.
  Keep factory-returned existing resources with their original owner and dispose each only once.
  Protect mutable container state with JavaScript private fields.
- 8a3923f: Scope controller and handler middleware to its HTTP method and route, preserving Hono onion and HEAD behavior. Defer request-scoped controller construction until handler invocation and route pipeline component construction errors through the HTTP reporting/filter boundary.

  Resolve asynchronous controller and scoped pipeline dependencies in their declaring module, including parameter pipes, without selecting another module's registration of the same class.

  Give every HTTP request and adapter route a managed invocation lifetime. Start deferred work after dispatch and wait for work plus response completion before disposing resources; retain async cleanup with native waitUntil and correctly finish HEAD/cancelled streams.

  Preserve configured middleware owners and short-circuit responses, use explicit async pipe hooks without speculative synchronous parsing, and report middleware failures before filtering using the existing request scope. Reject ambiguous controller owners instead of selecting the first registration.
- c7d108b: Capture the HTTP request context after body-limit normalization so middleware, guards, controllers, and adapters share the same readable Request and trusted identity. Keep request lifetimes active through oversized-body and body-read error reporting and cleanup.
- 54f8864: Preserve `APP_*` useExisting registrations as aliases, including their declaring
  module and inspectable target metadata. Global aliases retain singleton identity
  and request reuse, and now correctly resolve transient targets freshly instead
  of accidentally caching them in a synthetic singleton factory. Use an explicit
  singleton target when shared global state is intended.
- 363fb71: Honor originProtection.allowMissingOrigin for non-browser credentialed requests.
  The default policy and rejection of present invalid origins and invalid CORS
  preflights remain unchanged.
- de4e57e: Validate generated CRUD request bodies once in the engine, preserving schema metadata for OpenAPI without storing global validation receipts. Headless calls validate raw input independently. Keep consumeValidated as a deprecated compatibility method that returns false. Awaited CRUD identifier, body, persisted-row and response contracts use the shared async parser to avoid speculative Zod transforms. ValidationPipe adds transformAsync while preserving its synchronous transform API.
- 0765aaa: Use shared application finalization in testing, recalculate request scope after
  provider overrides, and dispose resources on failed startup and shutdown. Await
  concurrent disposal and managed test scopes. Add onClose fixture cleanup and close
  Node WebSocket test servers with their owning testing module.
- Updated dependencies [5205e58]
  - @velajs/live-protocol@1.23.0

## 1.24.0

### Minor Changes

- fe7587f: Add Standard Schema validation and operation contracts, authoritative tenant admission and audited persistence, optional Cedar authorization with exact query plans, and Web Crypto envelope/field/file encryption. Complete compound CRUD identifiers, parent scopes, structured predicates, signed cursors, page projections and post-commit delivery. Add transactional memory and Durable Object SQLite adapters, with D1/Workers and PostgreSQL conformance coverage.

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/errors@1.22.1
  - @velajs/live-protocol@1.22.1

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/errors@1.22.0
  - @velajs/live-protocol@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/errors@2.0.1
  - @velajs/live-protocol@2.0.1

## 2.0.0

Checked dependency injection, schema-bound HTTP endpoints and live queries, immutable verified identity, typed context boundaries, and read-only live inspection. Existing provider, context, lazy-loader, and live APIs require migration.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.21.0

### Minor Changes

- 7ec61f7: Harden the framework's HTTP, cache, signed-URL, storage-path, live, and WebSocket security boundaries.

  - HTTP now runs guards before argument decorators and pipes, returns 400 for malformed JSON, and applies `VelaSecurityOptions`: a 1 MiB body limit plus bounded query bytes/count/depth before middleware, with narrow streaming-route overrides.
  - Production and edge bootstraps emit explicit security warnings when global request/query limits are raised or disabled, a streaming limit is disabled, or WebSocket Origin isolation is opted out.
  - `SecurityModule` adds exact-origin CORS, credentialed state-change Origin protection, nosniff/referrer/frame/HSTS/CSP headers, and rejects wildcard origin configuration.
  - Shared response caching requires `@Cacheable()`, scopes custom keys beneath host/path/query, bypasses credentials unless a hashed principal/tenant variation is supplied, and never stores cookie-setting responses.
  - Signed URLs require explicit positive expiry, method, and purpose; use a method- and purpose-separated v2 payload; and reject empty secrets or missing expiry. Existing v1 signatures are intentionally incompatible.
  - Core no longer trusts forwarding headers for client identity. Trusted authentication guards can publish a framework-owned canonical principal/tenant identity, which throttling prefers before a context-aware custom tracker and the runtime-attested client address; unknown clients use a fail-closed shared bucket.
  - Raw Hono 5xx messages and health-indicator payloads are no longer reflected to clients; health failures retain full non-enumerable diagnostics for structured server reporting.
  - Throttler stores may return a platform-enforced allow/deny decision without fabricating an exact remaining quota; fixed backend limits fail closed when a route override does not match.
  - HTTP and WebSocket execution contexts expose the declaring module ID for module-scoped authorization.
  - Storage paths neutralize encoded traversal segments.
  - WebSocket gateways require explicit room parameters, default browser upgrades to same-origin, reject bearer-like query credentials, authenticate cookies or bounded single-use socket tickets into canonical `{ principal, tenantId, expiresAtMs }` state before allocation, support per-delivery authorization, enforce per-gateway inbound and outbound frame/room limits across direct sends, replies, local/Redis fan-out, reject invalid room ids, and fail closed when connection setup fails. Oversized output closes with 1009 and is never written.
  - WebSocket and Live identity expiry uses the explicit epoch-millisecond `expiresAtMs` field and rejects malformed or expired values. Live delivery re-runs authorization before resume and invalidation, caps sockets at 100 subscriptions and 32 rooms, caps presence metadata at 4 KiB, binds heartbeats and roster reads to transport-verified room membership, and no longer collapses distinct security callbacks into one dynamic module.

- 92b1f50: Add edge-safe, short-lived WebSocket socket tickets. Tickets use fixed-purpose HMAC claims bound to a gateway path, room, canonical principal, tenant, expiry, and generated nonce; strict verification atomically consumes the nonce through any structural `NonceStore` and fails closed for malformed, tampered, mismatched, expired, or replayed credentials.

## 1.20.0

### Minor Changes

- 1d584f8: Add the internal-dispatch seam: `InternalDispatcher.run()` re-enters the app through named routes using per-invocation HMAC-signed claims (audience-tagged, method/path/body-hash-bound, short-TTL, nonce single-use via a pluggable `NonceStore`), verified fail-closed by the new `@SignedInvocation()` guard. Shared HMAC/base64url plumbing is extracted to `crypto/hmac.ts` and reused by the existing signed-URL feature unchanged.
- 03570b1: Adopt the `ctx.run` signed re-entry seam in QueueModule and ScheduleModule, and add a queue disposition harness.

  - **Opt-in signed dispatch (default off, additive).** `QueueModule.forRoot({ dispatch: { kind: 'signed', target } })` and `ScheduleModule.forRoot({ dispatch: { kind: 'signed', target } })` re-enter a user-authored `@SignedInvocation()` route through `InternalDispatcher.run()` instead of the direct in-isolate `@Processor`/decorated-method path, so the job runs the full request pipeline (global guards/interceptors/filters). Absent (or `{ kind: 'direct' }`) keeps today's behavior exactly; `dispatch.kind` participates in the QueueModule dedup key. The schedule-node `ScheduleExecutor` reads the policy via an `@Optional` global `SCHEDULE_DISPATCH` token.
  - **Queue disposition harness** (`@velajs/vela/queue`): `observeMessage`/`observeBatch` WRAP (never mutate) a non-extensible host queue `Message` in a Proxy to record `ack`/`retry` outcomes and honestly infer `deadLettered` when the observer supplies `maxRetries` (`undefined` when unknown, never a misleading `false`). Platform-neutral testing/observability seam; not wired into any delivery path.

### Patch Changes

- 877699e: Fix `@SignedInvocation()` on handlers that declare `@Body()`. HTTP resolves handler arguments before guards (the documented NestJS-parity contract), so `@Body()` consumed the request body before `SignedInvocationGuard` could re-hash it to verify the claim's `bodyHash` — the guard's `request.clone()` then threw on the already-used stream, surfacing as a 500 instead of the intended 200/403. A new route-scoped capture middleware, composed onto every `@SignedInvocation()` route, hashes the raw body before it is consumed and publishes the digest to the guard via a request-keyed `WeakMap`; the guard prefers that captured hash and only falls back to hashing the live body when the middleware is absent (bare-guard misuse), where it now fails closed with a 403 rather than a 500. Token wire-format, guard semantics, the cross-isolate signed `InvocationTransport` path, and the args-before-guards machinery are all unchanged; bodyless invocations behave exactly as before.

## 1.19.1

### Patch Changes

- 50854e2: Modernize the package build, validation, and release toolchain.

## 1.19.0 (2026-07-11)

Exception-handler layer (roadmap phase 3): a single branded error concept, one
wire-redaction seam, and a Laravel-style reporting contract layered above the
NestJS-style exception filters.

### Added

- **`@velajs/errors` dependency** — the new sibling package vela now builds on:
  the branded `VelaError` (own+enumerable fields so it rides any wire codec /
  `structuredClone` / DO-RPC prop copy), error catalogs
  (`defineErrorCatalog`/`composeCatalogs`/`CORE_CATALOG`), and the single
  `toErrorBody` wire-redaction seam (unbranded or `internal`-coded errors never
  echo their message). Its core surface is re-exported from `@velajs/vela` so
  app authors need one import to throw branded errors, author handlers, and
  define/compose catalogs.
- **`ExceptionHandler` contract + `resolveErrorReporter`** — an optional
  application-wide handler (`report` / `dontReport` / `context` / `render`)
  consulted at every transport edge (HTTP, WS, live, queue, schedule). Reporting
  is fire-and-forget and fully contained: a broken or throwing handler (or
  `dontReport` matcher) can never mask the original error.
- **`APP_EXCEPTION_HANDLER` / `ERROR_CATALOG` tokens** — provide the handler and
  the composed catalog via module providers.
- **`ErrorsModule.forRoot({ catalogs?, handler? })`** — composes
  `[CORE_CATALOG, ...catalogs]` (eager; a duplicate code across catalogs fails
  fast with `duplicate error code`) into `ERROR_CATALOG`, and — when given —
  registers `APP_EXCEPTION_HANDLER` (`useClass` for a handler class, `useValue`
  for a handler object).
- **`app.useGlobalExceptionHandler(handler)`** — the imperative sibling of
  `ErrorsModule.forRoot({ handler })`; registers `APP_EXCEPTION_HANDLER` on the
  root container, taking effect on the next request without a rebuild.

### Changed

- **BREAKING (sanctioned wire break): the HTTP error body is now the canonical
  error object.** Uncaught controller/handler errors render as
  `{ error: { code, message, hint?, docsUrl?, details? } }` with the code's
  catalog status, replacing the prior `{ statusCode, message }` shape.
  `HttpException` object responses still ship verbatim (crud-envelope compat).
  Error reporting is now **report-first**: the reporter runs before any
  exception filter, so a filter claiming an error can no longer make it
  invisible to logging/Sentry. A new `app.onError` fallback funnels raw
  hono-middleware throws (which previously bypassed the filter tier entirely)
  through the same report + redaction path; hono's own `HTTPException`
  responses are still honored verbatim. Per the compat policy, shipped under a
  minor with no deprecation shim.

### Fixed

- **Live engine raw-message leak** — initial-subscribe resolver errors were sent
  to the browser as raw `err.message` (`src/live/live.engine.ts`); they now flow
  through `toErrorBody`, so unbranded/internal errors are redacted like every
  other edge. The WS exception frame and the report-then-rethrow queue/schedule
  dispatch paths were aligned to the same report-first + redacted-body invariant.

## 1.15.0 (2026-07-04)

Introspection seams for `@velajs/cli` (roadmap phase 3, CLI introspection):
serializable, zero-instantiation views of the app the CLI renders instead of
re-deriving framework internals.

### Added

- **`app.describeRoutes(): RouteDescription[]`** — every explicit controller
  route exactly as `build()` registered it: method AS DECLARED (`@Head()`
  reports HEAD even though Hono serves it under GET), fully composed path
  (global prefix + version segment + controller prefix + route path),
  controller name, handler name, version. Contributed routes
  (`RouteContributor`/CRUD) mount directly on Hono and are observable via
  `getHonoApp().routes`.
- **`app.getGlobalPrefix()`** — the prefix in effect ('' when none); also
  what `openapi` tooling threads into `createOpenApiDocument`.
- **`Container.getModuleDescriptions(): ModuleDescription[]`** — the loaded
  module graph (moduleId, imports, isGlobal, lazy, provider/export token
  labels), load order plus the `__root__` bucket; reads registration state
  only — safe pre/post bootstrap, never constructs, never claims lazy
  modules.
- **`describeToken(token)`** — the token-label helper vela's own errors use,
  exported for tooling.

## 1.14.0 (2026-07-04)

First-party `QueueModule` (roadmap phase 3, "the openness proof"): a whole
feature module authored on the public API alone — `defineModule` (+ `lazy`),
`createDiscoverableDecorator`, `registerEntrypointKind`, `app.entrypoints`,
`runInEntrypointScope`, `buildEntrypointExecutionContext`, `PipelineRunner` —
machine-verified by an import audit test.

### Added

- **`@velajs/vela/queue`** — platform-agnostic queue subsystem (subpath-only;
  deliberately NOT re-exported from the main barrel because
  `@velajs/cloudflare` already exports an unrelated CF-binding `QueueModule`).
  Producers: `QueueModule.forRoot({ queues: ['email'] })` + per-queue
  `QueueClient` injected via `queueToken(name)` (`add(jobName, data,
{ delayMs? })`). Consumers: `@Processor(queue)` classes with
  `@Process(jobName?)` handlers (named wins over wildcard; duplicates warn,
  first-wins). Dispatch runs each job in `runInEntrypointScope`
  (request-scoped deps rebuild per job), re-resolves processors by token
  through the async seam (lazy consumer modules — async init hooks included —
  materialize on first job), and applies scoped
  guards/interceptors/filters through the shared pipeline; unclaimed errors
  rethrow for platform retry. App-wide `APP_*` components deliberately do NOT
  run around queue jobs (cloudflare queue/scheduled parity; diverges from the
  WebSocket dispatcher — revisit framework-wide). The in-core `inline()`
  driver (edge-pure, no timers) delivers on a microtask (`immediate`) or via
  `flush()` (`manual`, rejects with `AggregateError` on unclaimed handler
  errors); platform drivers implement `QueueDriver` out-of-core and call
  `dispatchQueueJob(container, app.entrypoints, job)`. The module is
  `lazy: true` (dogfoods 1.13): consumer-only workers defer it entirely;
  an eager producer's client injection materializes it at bootstrap.
  `queues` is structural — `forRootAsync({ queues, useFactory })`.
- **`resolveScopedComponents(type, class, method, container)`** — public
  pipeline seam surfaced by the openness proof: scoped
  `@UseGuards`/`@UsePipes`/`@UseInterceptors`/`@UseFilters` resolution for
  custom dispatchers (declaration order preserved; conventions like
  closest-first filter reversal stay with the caller).
- **`EntrypointRegistry` is injectable** — the per-app registry registers
  into the container (global token) at the end of
  `callOnApplicationBootstrap()`, so providers that dispatch entrypoints
  themselves (the queue module's in-process driver binding) resolve it
  instead of needing a back-reference to the app; `container.has(...)` probes
  it safely pre-bootstrap (the queue binding falls back to
  `DiscoveryService` + `deferLazy` for deliveries during bootstrap).

## 1.13.0 (2026-07-04)

Cold-start laziness (roadmap phase 3): modules can defer their entire init to
first use, and the in-core subsystems an HTTP-only worker doesn't touch now
cost it nothing at bootstrap.

### Added

- **Lazy modules** — `@Module({ lazy: true })`, `DynamicModule.lazy`, and
  `defineModule({ lazy: true })` (also recognized per call site like
  `isGlobal`) defer a module _instance_'s entire provider/controller group:
  nothing constructs during `VelaFactory.create`. The first resolution of any
  of its tokens (injection, `app.get()`, a request hitting its controller, a
  dispatcher re-resolving an entrypoint token) claims the module; when the
  resolution stack unwinds, the group materializes and its
  `onModuleInit`/`onApplicationBootstrap` hooks replay in registration order,
  exactly once (memoized). Materialized instances join the instance flow so
  shutdown hooks stay symmetric; untouched modules get neither init nor
  shutdown hooks. Triggers during bootstrap absorb the group into the normal
  hook phases, ordered dependency-before-consumer. `useValue` reads (options
  tokens) do not trigger. Sync seams (`app.get`, the request pipeline) throw
  a descriptive error for lazy modules with async providers/hooks — reach
  those through `app.materializeLazyModules()` (the new warmup escape hatch)
  or keep them sync. Authoring contract: docs/modules.md "Lazy modules".
- **`app.materializeLazyModules()`** — materialize every still-pending lazy
  module (async-safe); warmup/eager-everything escape hatch.
- **`Container.isLazyPending(token)` / `Container.isInstantiated(token)`** —
  non-triggering diagnostics (build-time probes, cold-start regression tests).
- **`DiscoveryFilter.deferLazy`** — discovery returns providers of
  unmaterialized lazy modules as metadata-only entries (`instance:
undefined`, mirroring the request-scoped convention) instead of forcing the
  group. `EntrypointRegistry.build` uses it: declared-kind entrypoints of
  lazy modules are metadata-only in `app.entrypoints`; dispatchers that
  re-resolve by token (cloudflare cron/queue/scheduled already do)
  materialize the owning module at dispatch time. `ContributesEntrypoints`
  providers in lazy modules are materialized right before the snapshot —
  computed contributions can't defer (documented cost).

### Changed

- **`EventEmitterModule`, `ScheduleModule`, `SeederModule`, `I18nModule` are
  now lazy.** An HTTP-only worker that imports them but never emits an event,
  reads the schedule registry, runs seeders, or translates pays zero
  cold-start cost for them — no subscriber wiring pass, no `@Cron` discovery
  walk, no merged-message snapshot. Every consumer path is a trigger, so
  observable behavior is unchanged (`app.get(EventEmitter).emit(...)` wires
  subscribers first; `runSeeders()` populates the registry via hook replay).
  `WebSocketModule` and `ScheduleNodeModule` deliberately stay eager (gateway
  injection drags the WS chain in anyway; the node executor is self-driving).
- `ModuleLoader.resolveAllInstances()` skips tokens owned exclusively by lazy
  module instances; a token also registered by a non-lazy module stays on the
  eager pass. Route building no longer instantiate-probes middleware tokens
  that are lazy-pending (default priority 0) — the probe would have defeated
  i18n's deferral at route build.

## 1.12.0 (2026-07-04)

The module-model release: one blessed authoring path plus public kernel
extension points, so feature modules (websocket, storage, queue, …) are built
entirely on the public API. See `docs/modules.md` for the author contract.
Contains deliberate breaking changes (no deprecation shims); coordinated
releases of `@velajs/{storage,better-auth,testing,crud,cloudflare}` accompany
this version.

### Added

- **`defineModule`** — the single module-authoring engine: generates `forRoot`
  AND `forRootAsync` (typed `inject` inference), derives deterministic
  `stableHash` keys (`key(options)` override + explicit `key` passthrough),
  and accepts contributions (providers/controllers/imports/exports) **as
  functions of the options** plus a standardized `global:` component slot.
  `ConfigurableModuleBuilder` is now a thin adapter over it (unchanged API).
- **Authoring primitives**: `lazyProvider` (memoized deferred thunk — replaces
  the hand-rolled `(...deps)=>()=>fn(...deps)` closures), `provideGlobal`
  (the one `APP_*` wiring idiom), `sideEffectModule` (first-class
  contribution-only modules; supported form of the i18n empty-marker trick),
  `moduleToken`, `moduleKey`.
- **`DiscoveryService` + `createDiscoverableDecorator`** — public
  decorator-driven discovery (`providersWithMeta`, `methodsWithMeta`,
  `getProviders`) backed by a reverse metadata index inside
  `MetadataRegistry`; honors container diagnostics in one place;
  request-scoped providers are surfaced but not materialized (opt in with
  `includeRequestScoped`). The event-emitter, schedule, and websocket
  bootstrap scans now all run through it.
- **Open entrypoint registry** — `registerEntrypointKind({ kind, metaKey,
level })`, the `ContributesEntrypoints` interface, and per-application
  `app.entrypoints` (`ofKind`/`kinds`/`all`), built at the end of
  `callOnApplicationBootstrap()` so slim bootstrap paths (Cloudflare Durable
  Objects) get it too. Transports query entrypoints instead of module
  internals; a new kind (queue, cron, CLI) needs **zero core changes**.
- **`RouteContributor`** — public metadata-claimed route generation
  (`registerRouteContributor`), consulted after explicit routes and during
  OpenAPI generation with verb-level merge. Replaces the internal CrudBridge.
- **`RuntimeAdapter`** — `VelaFactory.create(module, { adapters: [...] })`
  with `requestMiddleware` (prepended to the global chain), `onBootstrap`
  (after lifecycle + entrypoints, before routes) and `onRoutesBuilt` hooks.
- **`PipelineRunner`** — the shared guard → pipe → interceptor execution core
  used by HTTP and WebSocket dispatch (and any custom dispatcher);
  configurable args/guards order, transport-specific guard-rejection error.
- **`Container.replaceProvider(provider, { buckets })`** — supported
  force-replace across module buckets (what test harnesses need).
- **`buildEntrypointExecutionContext(kind, class, handler, payload)`** — the
  entrypoint sibling of the HTTP/WS execution contexts, so guards/
  interceptors/filters written against `getClass()`/`getHandler()`/`getType()`
  run unchanged around queue batches, scheduled ticks, and custom kinds
  (`EntrypointExecutionContext.getPayload()`). `@velajs/cloudflare` dispatches
  queue/scheduled handlers through `PipelineRunner` with consumer-scoped
  components (HTTP-global components deliberately do not apply; unclaimed
  errors rethrow to preserve platform retry semantics).
- **`runInEntrypointScope(container, fn)`** — the non-HTTP dispatch scope
  primitive: runs one unit of work (queue batch, scheduled tick, RPC call) in
  a fresh request-scoped child with LIFO disposal — the per-request-child
  equivalent for entrypoint dispatchers. `@velajs/cloudflare`'s queue and
  scheduled handlers run on it (request-scoped consumer deps rebuild per
  batch/tick instead of capturing boot instances).

### Changed

- **Factory dependency visibility**: `useFactory`/`forRootAsync` `inject`
  deps now resolve from the declaring module's scope FIRST (imports and
  exports are honored), with the legacy no-requester lookup kept as fallback.
- **All in-core configurable modules are on the one engine**: `CorsModule` and
  `SeederModule` rebuilt on `defineModule` (Cors gains `forRootAsync`; both
  keep their token/key identities), `ScheduleModule`/`ScheduleNodeModule`
  normalized to zero-config `@Module` bags with parity `forRoot()` sugar.
  Builder-based modules (Config/Cache/I18n/Throttler/Http) already run on it
  through the `ConfigurableModuleBuilder` adapter.
- **Unhandled handler errors are logged**: an error no exception filter claims
  still maps to the generic 500 response, but the cause now lands in the logs
  (`console.error`, gated on container diagnostics ≠ `silent`) — closing the
  silent-500 gap.
- **`WebSocketModule`** rebuilt on `defineModule`: registry → driver → server
  construction moved into chained provider factories (single shared registry
  preserved; everything materializes at bootstrap), deterministic key
  `ws#<sync-kind>` — **two identical `forRoot()` calls now dedup**
  (HMR-idempotent; pass explicit `key` for exotic multi-instance),
  `forRootAsync` available. `WsDispatcher` contributes `'websocket'`
  entrypoints; `registerWebSocketGateways` consumes
  `app.entrypoints.ofKind('websocket')`.

### Breaking

- **`WS_MODULE_OPTIONS`** is now a typed `InjectionToken` (was the raw string
  `'vela:ws-module-options'`).
- **`ComponentManager`** is stateless: `init()` and the process-global
  container are gone; `resolve*` methods require an explicit container;
  `getComponents` replaced by `getScopedComponents` (controller + handler
  only — app-wide components have one source: `RouteManager`).
  `registerGlobal`/`MetadataRegistry.getGlobal` (a dead tier with no readers
  on the request path) are removed; `MetadataRegistry.clear()` is now a
  no-op.
- **CrudBridge removed** (`registerCrudBridge`/`getCrudBridge` and the
  `/internal` exports): use `registerRouteContributor`. `@velajs/crud`
  migrates in its coordinated release.
- `forRootAsync` structural fields (non-async keys passed alongside
  `useFactory`) now merge under the resolved options.

## 1.10.0 (2026-07-01)

### Added

- **WebSocket support** (`@velajs/vela/websocket` + `@velajs/vela/websocket-node`): `@WebSocketGateway`, `@SubscribeMessage`, gateways run through the same global guard/pipe/interceptor/filter tiers as HTTP (`RouteManager.getGlobalComponents()`).

- **`ConfigurableModuleBuilder`** (NestJS-parity) + the lower-level `defineConfigurableModule` engine. Generates `forRoot`/`forRootAsync` (with `key`, `global`, `useClass`/`useExisting` async options, and the options token) from a tiny spec, so a new module is just its tokens + options type + service + a `@Module({...})` bag — while keeping vela's module encapsulation and multi-instance `key` dedup. `CacheModule`, `ConfigModule`, `ThrottlerModule`, and `HttpModule` are migrated onto it; `@velajs/cloudflare`'s binding modules reuse the engine.
- **Opt-in ambient request access**: `getCurrentContainer()` / `getCurrentRequestContext()` + `enableAmbientContainer()`, wired via `VelaFactory.create(module, { ambientContainer: true })`. Backed by Hono's `hono/context-storage` (no `node:async_hooks` import in core); OFF by default, explicit child-container path unchanged. On Cloudflare Workers it requires the `nodejs_als` (or `nodejs_compat`) flag — validated on real workerd.
- **Container + application disposal**: `Container.dispose()` (LIFO; `Symbol.asyncDispose`/`Symbol.dispose`/`.dispose()`, idempotent), `VelaApplication.dispose()` and `Symbol.asyncDispose` (enables `await using`). The root disposes shared singletons; the per-request child container is disposed automatically at the end of each HTTP request — streaming-safe (deferred until the response body drains) and zero-overhead when a request has no request-scoped disposables.
- **Async cache stores (additive, non-breaking).** New `AsyncCacheStore` interface + `TieredCacheStore` (read-through + backfill + write-through over N sync/async tiers) in core, and `KVCacheStore` in `@velajs/cloudflare`, for a memory→KV cache. The existing synchronous `CacheStore`/`CacheService`/`CacheInterceptor` are **unchanged**; `CacheModuleOptions` gains an optional sync `store`. Use the async stores programmatically (inject under your own token).
- **i18n** at the `@velajs/vela/i18n` subpath (keeps core lean; `intl-messageformat` is an optional peer dep): `I18nModule.forRoot()` + `registerMessages()` (deep-merged, HMR-safe globalThis registry), ICU formatting, header/query/cookie locale detection. `I18nService` is request-scoped and reads the per-request locale; injecting it into a controller is safe thanks to request-scope bubbling (no `ambientContainer` flag needed).
- **Storage abstractions** at the `@velajs/vela/storage` subpath (dep-free, Web Crypto only): the `StorageDriver` contract, `expandPathTemplate`/`joinStoragePath`, and HMAC `signUrl`/`verifySignedUrl`. `@velajs/cloudflare` builds on them with a multi-disk `StorageModule` over R2 (`StorageService.put/get/delete/exists/url`, per-disk roots with `{date}`/`{year}`/… templates, bucket-by-name via `EnvService`) plus a signature-gated `StorageController` presign-proxy (R2 has no native presign).
- **Seeders** at the `@velajs/vela/seeder` subpath: `@Seeder({ order })`, `SeederModule` (`forRoot({ seeders })`), and `SeederRegistry`/`runSeeders(app)` — decorator discovery at bootstrap (mirrors `ScheduleRegistry`), each seeder run in a request-scoped child. Paired with the **new `@velajs/cli` package** (clipanion) providing `vela db seed` driven by a `vela.config.{js,mjs,ts}` app factory (Node-side; kept out of the Worker bundle).

### Changed

- **Request-scope bubbling.** A provider (including controllers, which are singletons) that transitively depends on a request-scoped provider is now automatically treated as request-scoped — rebuilt per request instead of capturing the first request's instance. Matches NestJS; computed once at bootstrap (`Container.computeEffectiveScopes`), governs caching + eager instantiation. Fixes the captive-dependency hazard for request-scoped services injected into controllers.
- **HMR-safe `MetadataRegistry`**: all backing state is now anchored on `globalThis` via `Symbol.for('vela:registry:v1')`, so a Vite dev re-eval reuses the state classes were decorated against (no split-brain: lost routes / spurious "not @Injectable" warnings / duplicated globals). No API change.
- **`CacheModule`** now accepts an optional custom sync `store` in its options.

## 1.8.1 (2026-05-14)

### Revert

- **`OnFirstRequest` lifecycle hook removed.** Shipped in 1.8.0 to bridge module-load and request-time semantics for runtime-bound state (Cloudflare bindings, etc.). In practice, consumers can achieve the same deferral with a plain `@Injectable()` service holding the state as a lazy-cached field via a getter — the idiomatic NestJS pattern, no framework primitive required. Adding a lifecycle hook with zero in-tree consumers was YAGNI; reverting before it accumulates dependents. Apps that pinned to 1.8.0 and used `OnFirstRequest` should migrate to the lazy-service pattern before upgrading.

### Notes

- 1.8.0 remains published on npm but no longer the `latest` tag.
- `OnApplicationBootstrap`, `OnModuleInit`, and the existing lifecycle hooks are unchanged.

## [1.6.0]

The exception-filter chain now reaches into attached middlewares for full NestJS parity, and a new `createLazyParamDecorator` helper closes the parameter-decorator-vs-guard ordering hazard at the public-API surface.

### Added

- **`createLazyParamDecorator((data, ctx) => T)`.** Custom parameter decorators whose factory runs the _first time the handler reads a property on the resolved value_ — not during argument extraction. Vela's argument resolver runs before guards by design (`extract args → guards → handler`), which means a `createParamDecorator` factory that depends on guard-populated state observes an empty slot. The lazy variant returns a `Proxy` whose traps invoke the factory on demand; the `get` trap short-circuits `prop === 'then'` so `await value` does not consider the proxy a thenable and therefore does not trigger eager resolution. Method results are auto-bound to the resolved real target so detached calls keep `this`; `ownKeys` + `getOwnPropertyDescriptor` are implemented so `JSON.stringify(value)` works after one access. Exported from the root barrel and from `@velajs/vela/internal` via the same surface as `createParamDecorator`. Documented in README under _Custom parameter decorators with deferred resolution_.

### Changed

- **Exception-filter chain now catches errors thrown inside vela-attached middlewares.** Previously the `APP_FILTER` / `@UseFilters` chain only handled errors thrown from `@Controller` handler methods; errors from middlewares (global, `MiddlewareConsumer.apply(...).forRoutes(...)`, and per-route attached) bypassed the chain and surfaced as Hono's outer 500. They now flow through the same filter resolution as handler exceptions, with a synthesized `ExecutionContext` whose `getClass()` returns the `VelaMiddlewareHost` marker and whose `getHandler()` returns the `Symbol.for('vela.middleware')` sentinel — `getType()` stays `'http'` for NestJS parity. Only global filters apply at the middleware boundary (per-handler `@UseFilters` requires a controller call frame); for thrown `HttpException`s with no catching filter, the chain renders the exception's own response/status (matching handler-thrown semantics). Non-`HttpException` throws with no catching filter re-throw to preserve the existing default-500 path. Non-throwing middleware paths (returning a `Response`, calling `await next()`, resolving a promise) are byte-identical to before.

## Unreleased

A sanctioned per-request injectable lands as a framework primitive, the metadata-store unification finally has its regression tests, and dynamic module identity becomes consistent — closing the last open audit item.

### New

- **Dynamic module identity is now first-class** (audit #2 — last open item, fully closed). `DynamicModule` gains an optional `key?: string`; module authors call `key: stableHash(options)` inside `forRoot()` so two distinct option sets register as distinct module instances. The DI container is bucketed per-module (`Map<moduleId, Map<Token, Registration>>`) so the same logical token can have distinct registrations in different buckets — e.g., `imports: [CacheModule.forRoot({ttl:60}), CacheModule.forRoot({ttl:120})]` now actually produces two reachable cache configs instead of silently dropping one. A consumer module that imports both throws `MultipleProvidersFoundError` with both candidate ids in the message; resolve only one and the ambiguity disappears. `[HttpModule, HttpModule.forRoot({base:X})]` registers both and the loader emits a diagnostic warning. `createModuleRef()` is removed — module authors use `{module: RealClass, key}` directly. New helpers `defineDynamicModule()` and `stableHash()` are exported from the root.

  Pre-fix this swallowed configuration silently in two places: same-class `forRoot` calls collided at `processedModules.has(class)`, and synthetic-class-per-call patterns (the old `HttpModule`) collided at the container's `if (!has(token))` provider guard. Both guards are gone.

- **`REQUEST_CONTEXT` injectable.** A request-scoped primitive carrying a stable `id` (mirrored from inbound `x-request-id` if present, else `crypto.randomUUID()`), `receivedAt`, the raw `Request`, the Hono `Context`, and a typed `set/get/has` bag for cross-cutting metadata. Seeded by `RouteManager` into each per-request child container; resolves through `@Inject(REQUEST_CONTEXT)` from any request-scoped service. No `AsyncLocalStorage` — edge-runtime contract intact (verified live under workerd via `pnpm test:workers`).

  ```ts
  import { Inject, Injectable, Scope, REQUEST_CONTEXT } from "@velajs/vela";
  import type { RequestContext } from "@velajs/vela";

  @Injectable({ scope: Scope.REQUEST })
  class TenantResolver {
    constructor(
      @Inject(REQUEST_CONTEXT) private readonly ctx: RequestContext
    ) {}
    resolve() {
      return this.ctx.hono.req.header("x-tenant") ?? "default";
    }
  }
  ```

### Breaking

- **`createModuleRef()` removed.** The synthetic-class-per-`forRoot()` workaround is gone; modules use `{ module: RealClass, key }` instead. First-party modules (`HttpModule`, `CacheModule`, `ConfigModule`, `ThrottlerModule`, `CorsModule`) are migrated. Sibling consumers (`@velajs/cloudflare`, `@velajs/crud`) need to switch from `createModuleRef('${name}_${key}')` to `key: ...` on the DynamicModule.
- **Container provider storage shape changed.** `Container.providers` is now `Map<moduleId, Map<Token, Registration>>` instead of flat. `providerOrigin` is removed (origin is now `declaringModuleId` on each `ProviderRegistration`). `assertVisible` is removed (its role is subsumed by lookup-or-throw in `resolve`). `Container.has(token)` is preserved (any-bucket scan); a new `Container.hasInScope(token, moduleId)` is the strict variant. `resolveAll(token)` is now a real walk across reachable buckets, not a stub. New error: `MultipleProvidersFoundError` when an imports walk yields >1 candidate. New constant: `ROOT_MODULE_ID = '__root__'` (sentinel bucket for bootstrap primitives and sandbox registrations).

### Internal cleanup

- **Metadata stacking + funnel coverage** (audit #8 follow-up). New `metadata-stacking.test.ts` asserts `appendCustomHandlerMeta` is order-deterministic, `Reflect.defineMetadata` round-trips through `MetadataRegistry`'s typed slots, `MetadataRegistry.reset()` clears `classMeta`/`handlerMeta`, and class+handler `@SetMetadata` on the same key remain independent.
- **`NestModule.configure()` regression coverage** (audit #4 follow-up). New `configure-resolution.test.ts` asserts configure-time DI works (modules can constructor-inject providers from their own scope), synchronous errors thrown from `configure()` propagate, and unresolvable constructor deps fail loudly rather than silently skipping middleware setup.
- **Edge-safe contract documented** (audit #7 follow-up). README now states the contract explicitly: the main export is edge-safe and audited in CI by `src/__tests__/edge-runtime-audit.test.ts`; `@velajs/vela/schedule-node` is the one opt-in Node/Bun carve-out.
- **`RouteManager` split into focused units** (audit #9 follow-up). New files `argument-resolver.ts`, `handler-executor.ts`, `response-mapper.ts`, and `instantiate.ts` carry parameter extraction, the per-request orchestration closure, response/redirect mapping, and the container-aware factory. `RouteManager` is now focused on Hono route registration and path composition. Internal-only refactor — no public API change, no behavior change.
- **Stale `WeakMap` comment removed** from `MetadataRegistry.reset()` — the WeakMap fallback was retired in 1.1.0; the comment was documentation drift.
- **`Container.setRequestInstance(token, value)`** — public method to pre-seed the per-request cache. Used by `RouteManager` to populate `REQUEST_CONTEXT` before any handler resolution runs.

## 1.3.0

Module boundaries are enforced. NestJS-shape: a service cannot resolve dependencies from a module it didn't import. Bootstrap is consolidated into a single primitive, discovery failures are diagnostically routed, and a generic plugin composer is included.

### New

- **Module visibility enforcement.** `VelaFactory.create(Mod)` checks every constructor injection: the token must be declared locally, exported by an imported module, marked `@Global`, or be an `InjectionToken` with a default factory. Throws `ModuleVisibilityError` with an actionable message on violation. Auto-registration of unknown class tokens is gone — declare every dependency in a module's `providers`. There is no opt-out flag; `ModuleRef.create()` is the sandbox escape hatch for transient instantiation.

- **`bootstrap(rootModule, options)`** — the wiring primitive shared by `VelaFactory.create`, `@velajs/testing`, and any non-HTTP consumer (CLI tools, custom runtimes). Returns `{ container, routeManager, loader }` without running lifecycle hooks or building the Hono app. `VelaFactory.create` is now a thin wrapper that calls `bootstrap()` then runs `OnModuleInit` / `OnApplicationBootstrap` and builds routes. Exported from `@velajs/vela` and `@velajs/vela/internal`.

- **Module visibility primitives.** `Container({ diagnostics })`, `ModuleScope`, `Container.registerScope`, `Container.markGlobalToken`, and `ModuleVisibilityError`. `useExisting` aliases honor visibility (alias targets the caller can't see are rejected).

- **Self-providing tokens stay visible.** `new InjectionToken('X', { factory: () => Y })` is implicitly globally visible — the token's factory IS its provider, so no explicit declaration is required.

- **Factory inject is a framework-level escape hatch.** `useFactory` provider deps (including `forRootAsync`, `registerAsync`) resolve without a module-visibility requester, so factory `inject: [...]` arrays can pull from the importing module's scope. A future `forRootAsync({ imports })` will tighten this; for now it's permissive by design.

- **Discovery diagnostics: `{ diagnostics: 'silent' | 'log' | 'throw' }`** (default `'log'`). Failed provider/controller resolution at `loader.resolveAllInstances`, schedule discovery, event-emitter discovery, and runtime job execution route through one dispatcher. `ModuleVisibilityError` always propagates regardless of mode.

- **Live Cloudflare Workers smoke tests.** `pnpm test:workers` runs vela inside workerd via `@cloudflare/vitest-pool-workers` (driven by a test-only `wrangler.toml`). Validates the edge-runtime contract end-to-end — boot, request lifecycle, per-request DI without `AsyncLocalStorage`, handler-chain order, OpenAPI mount — beyond what the static edge-audit can catch. Wired into CI alongside `pnpm test`.

- **Framework primitives are globally visible.** `Container`, `ModuleRef`, and `APP_GUARD`/`APP_PIPE`/`APP_INTERCEPTOR`/`APP_FILTER`/`APP_MIDDLEWARE` are marked global at boot — resolvable from any module without explicit imports, in both strict and non-strict mode. `ModuleRef.create()` continues to be the sandbox escape hatch (visibility check skipped for transient instantiation).

- **Plugin manifest + composer** — `definePlugin({ id, version, module, dependsOn?, metadata? })` and `composePlugins(plugins): DynamicModule` with topological sort, cycle detection, and missing-dep detection. Produces a global module that exposes a queryable `PluginRegistry` via `PLUGIN_REGISTRY_TOKEN` (`list`, `get(id)`, `dependents(id)`).

- **New types**: `ModuleScope`, `ContainerOptions`, `BootstrapOptions`, `BootstrapResult`, `Diagnostics`, `Plugin` — exported from both root and `/internal`.

### Internal cleanup

- **`Container` constructor accepts `ContainerOptions`** (`{ diagnostics? }`). Threads `requestingModuleId` through `resolve` / `resolveAsync` / `resolveAll`. Per-module scopes are tracked via `registerScope`; framework-internal globals via `markGlobalToken`. `providerOrigin: Map<Token, string>` records each provider's declaring module so constructor injections resolve from the _class's_ module, not the caller's. Visibility enforcement runs whenever a `requestingModuleId` is supplied — there is no on/off switch.

- **`ModuleLoader` registers a `ModuleScope` per module** before recursing into imports — `localProviders` includes the module class itself (so `NestModule.configure()` resolution stays inside its own scope), controllers, and every provider token. Synthetic `APP_*` tokens are marked global at mint time so RouteManager's request-time resolutions (no requester) keep working.

- **`createChild()` shares container state by reference** (providers, scopes, globals, providerOrigin); `createDetached()` copies providers + providerOrigin and shares scopes + globals. Re-registering a token on a detached container without a moduleId clears any stale `providerOrigin` so sandbox-local registrations don't inherit a misleading owner.

- **`resolveAsync` factory branch now unwraps `ForwardRef` in `inject`** (mirroring the sync `resolveFactory`). Previously asymmetric — sync path worked, async path silently failed during `loader.resolveAllInstances` and was swallowed by the discovery `try/catch`.

- **Dropped unused `Container.parent` field** (audit #10). Was assigned in `createChild()` but never read.

- **Bootstrap consolidated into `src/factory/bootstrap.ts`** — `VelaFactory.create` no longer hand-rolls the APP\_\* / consumer-middleware / global-prefix wiring sequence. Net code reduction in `factory.ts`.

## 1.1.0 (2026-04-30)

Architectural remodel: one metadata model, one storage, public surface trimmed, internal primitives exposed via a stable subpath.

### Breaking changes

- **`createApplication` removed.** Use `VelaFactory.create(AppModule)` directly.

  ```diff
  - import { createApplication } from '@velajs/vela';
  - const app = await createApplication(AppModule);
  + import { VelaFactory } from '@velajs/vela';
  + const app = await VelaFactory.create(AppModule);
  ```

- **`RequestMethod` removed; `HttpMethod` is canonical and now uppercase.** The two enums had the same purpose but different cases (`'get'` vs `'GET'`). Unified to uppercase to match HTTP spec and Hono's request `method` field.

  ```diff
  - import { RequestMethod } from '@velajs/vela';
  - .forRoutes({ path: '/api', method: RequestMethod.POST });
  + import { HttpMethod } from '@velajs/vela';
  + .forRoutes({ path: '/api', method: HttpMethod.POST });
  ```

- **`@Controller({ prefix })` removed; `@Controller({ path })` only.** `prefix` was a non-canonical alias.

  ```diff
  - @Controller({ prefix: '/users', version: 1 })
  + @Controller({ path: '/users', version: 1 })
  ```

- **`HttpModule.register` / `registerAsync` renamed to `forRoot` / `forRootAsync`.** Same for `CacheModule.registerAsync` → `forRootAsync`. Matches NestJS canonical naming and aligns the rest of the framework's dynamic-module shape.

  ```diff
  - HttpModule.register({ baseURL: '...' })
  - HttpModule.registerAsync({ ... })
  - CacheModule.registerAsync({ ... })
  + HttpModule.forRoot({ baseURL: '...' })
  + HttpModule.forRootAsync({ ... })
  + CacheModule.forRootAsync({ ... })
  ```

- **`MetadataRegistry`, `RouteManager`, `ModuleLoader`, `ComponentManager`, `Container`, `VelaApplication` (the class), `bindAppProviders`, and the `APP_*` tokens moved to a stable internal subpath.** The public root barrel still re-exports `MetadataRegistry` (used by tests for `clear()`), but plugin authors should consume framework primitives from `/internal`:

  ```diff
  - import { RouteManager, ModuleLoader, ComponentManager } from '@velajs/vela';
  + import { RouteManager, ModuleLoader, ComponentManager } from '@velajs/vela/internal';
  ```

- **`Test`, `TestingModule`, `TestingModuleBuilder` removed from `@velajs/vela`'s root barrel.** Use `@velajs/testing` (≥ 0.2.0) — it's the canonical home and was rewritten on top of `@velajs/vela/internal`.

- **`HttpException._response` typed as `string | Record<string, unknown>`** (was `string | object`). `getResponse()` now returns `Record<string, unknown>`.

- **`applyDecorators` return type** changed from the impossible-at-runtime `ClassDecorator & MethodDecorator & PropertyDecorator` intersection to a `ComposedDecorator` polymorphic shape that matches every decorator slot structurally.

- **`Reflector` API takes `ExecutionContext` directly.** Was a duck-typed `{ getClass(): Constructor; getHandler(): string|symbol }` parameter; now the real type. Existing call sites that already pass an `ExecutionContext` need no change.

- **Inverted peer dep removed**: `@velajs/vela` no longer declares `peerDependencies['@velajs/crud']`. Crud is the consumer; that line was reversed.

### New

- **`@velajs/vela/internal` subpath export.** Re-exports `MetadataRegistry`, `Container`, `ModuleRef`, `RouteManager`, `ModuleLoader`, `ComponentManager`, `VelaApplication`, `bindAppProviders`, `APP_GUARD`/`APP_PIPE`/`APP_INTERCEPTOR`/`APP_FILTER`/`APP_MIDDLEWARE`, `getModuleMetadata`, `isModule`. Stable target for plugins.

### Internal cleanup

- **One metadata storage.** Decorators no longer dual-write to a typed `MetadataRegistry` slot AND a parallel `WeakMap` polyfill. The `Reflect.metadata` polyfill now funnels into `MetadataRegistry.classMeta`/`handlerMeta`, which also backs `setCustomClassMeta`/`setCustomHandlerMeta` and the `appendCustomClassMeta`/`appendCustomHandlerMeta` helpers.
- **`MetadataRegistry.clear()`** now clears only app-time global components (the only mutable run-time slot). Decoration metadata persists across `clear()`, so tests no longer need a fallback path. Use `MetadataRegistry.reset()` for a full wipe.
- **No `!` non-null assertions** in `MetadataRegistry`. New `getOrCreate`/`getOrCreateMap`/`getOrCreateArray` helpers in `registry/util.ts`.
- **No `as unknown as` casts** in `MetadataRegistry`. Component stores are now mapped-typed instead of union-typed.
- **`Constructor` is now `abstract new (...args: any[]) => unknown`** (was the bare unsafe `Function`). Every decorator's `target` casts to `Constructor` consistently.
- **Single home for shared types**: `Type`, `Token`, `Constructor`, `ProviderOptions`, `InjectableOptions`, etc. canonical in `container/types.ts`. `ModuleOptions`, `DynamicModule`, `ModuleImport`, `AsyncModuleOptions`, `ModuleMetadata` canonical in `registry/types.ts`. `module/types.ts` is a thin re-export. The `InjectionTokenLike` duck-type and the duplicated `ProviderOptions` are gone.
- **Layering fixed**: `MiddlewareConsumer`/`MiddlewareBuilder`/`NestModule`/`RouteInfo` moved from `http/` to `module/`. `module/module-loader.ts` no longer imports from `http/`.
- **`module-loader` `new moduleClass()` footgun fixed.** `NestModule.configure()` modules are now resolved through the container, so they can have constructor-injected deps.
- **One path util** (`registry/paths.ts`: `normalizePath`, `joinPaths`, `toOpenApiPath`). Replaces 2× duplicated implementations in `http/decorators.ts`, `openapi/document.ts`, and `route.manager.ts`.
- **One `ExecutionContext` factory** (`http/execution-context.ts`: `buildExecutionContext`). Replaces 2× duplicated literal construction.
- **One `bindAppProviders` helper** (`pipeline/app-providers.ts`). Implements the NestJS APP*\* provider convention in one place; replaces 5× duplicated APP*\* wiring blocks across `factory.ts` and `testing.builder.ts`.
- **One module-graph walk** (`module/graph.ts`: `collectControllers`). Replaces the duplicate implementation in `openapi/document.ts`.
- **schedule/event-emitter/openapi decorators** now use `MetadataRegistry.appendCustomClassMeta`/`appendCustomHandlerMeta` instead of direct `Reflect.defineMetadata` calls.
- **Stub `pnpm-workspace.yaml` and `bunfig.toml` deleted** — they only set `onlyBuiltDependencies`, which lives in `package.json#pnpm`. `bun.lock` deleted; pnpm is the source of truth.

## 0.10.0 (2026-04-28)

Edge-runtime audit and AI-drift cleanup.

### Breaking changes

- **Schedule module split.** `ScheduleExecutor`, `SCHEDULE_MODULE_OPTIONS`, and `ScheduleModuleOptions` are no longer exported from `@velajs/vela`. The `setInterval`-based timer executor moved to a new opt-in sub-export at `@velajs/vela/schedule-node`. Consumers on Node or Bun should now do:

  ```ts
  import { ScheduleNodeModule } from "@velajs/vela/schedule-node";

  @Module({ imports: [ScheduleNodeModule.forRoot()], providers: [JobsService] })
  class AppModule {}
  ```

  `ScheduleModule.forRoot()` is now metadata-only — `enableTimers` is no longer accepted (drop the option entirely). `ScheduleModule.forRootAsync()` was removed (no options to async-resolve).

  Edge runtimes without `setInterval` (Cloudflare Workers, etc.) should continue to use platform cron triggers — `@velajs/cloudflare` ≥ 0.2.0 dispatches core `@Cron` jobs via its `scheduled()` handler.

- **TypeScript enums replaced with `as const` objects** for `HttpMethod`, `ParamType`, `Scope`, `RequestMethod`, and `LogLevel`. Value access (`HttpMethod.GET`) keeps working; type-position usages (`: HttpMethod`) keep working via same-name type aliases. Code that imported the enum _type_ with structural assumptions about enum runtime shape may need adjustment.

### Fixes

- `@Head()` is now HEAD-only. Previously it registered as a plain GET handler, so `GET` requests would also hit `@Head()`-decorated methods.
- Handler-level guards / pipes / interceptors / filters now key off the controller constructor instead of `${className}:${method}`, fixing a metadata collision when two controllers shared a class name (across feature modules or after minification).
- Removed an obsolete narration comment in `route.manager.ts`.

### New

- `@velajs/vela/schedule-node` — opt-in entry for Node/Bun cron and interval execution.
- `parseCron(expression)` and `CronMatcher` exported from the core for use by platform cron adapters.
- Edge-runtime audit test (`src/__tests__/edge-runtime-audit.test.ts`) — fails CI if any file under `src/` (excluding `schedule-node/`) references forbidden APIs (`node:*`, `Buffer`, `process.*`, `__dirname/__filename`, `fs/path/os/child_process`, `setInterval`, `Bun.serve`).

## 0.1.0 (2026-02-19)

Initial release.

- Decorator-based controllers with full HTTP method support
- Dependency injection with singleton, transient, and request scopes
- Module system with imports, exports, and dynamic modules
- Guards, pipes, interceptors, exception filters, and middleware
- Built-in pipes: ParseIntPipe, ParseFloatPipe, ParseBoolPipe, DefaultValuePipe, RequiredPipe, ZodValidationPipe
- 18 built-in HTTP exceptions
- Custom metadata with SetMetadata + Reflector
- Custom parameter decorators via createParamDecorator
- Route versioning
- Global prefix support
- Lifecycle hooks
- Optional hono-crud integration via `vela/crud`
- Edge runtime compatible (Cloudflare Workers, Deno, Bun, Node.js 20+)
