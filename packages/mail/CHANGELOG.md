# @velajs/mail

## 1.35.0

### Minor Changes

- 9a00506: Align module APIs with instance ownership: shared facilities use forRoot, local and named services use register, and Queue, I18n and Seeder contribute declarations through forFeature. Remove replaced APIs. Local registrations receive independent identities; reused definitions share within an application, and explicit keys retain conflict checks.
  
  Require applications to attach exported guards and interceptors explicitly. Remove automatic installation and guard options while preserving policy ownership, request scope, phase ordering, testing overrides and integration-route exemptions. Keep translation contributions and mutable runtime configuration isolated per application, and return runtime-only settings from async factories. Storage separates structural httpController mounting from runtime http options.
  
  Add schema-first GraphQL resolver and parameter decorators with exact provider ownership, endpoint selection and duplicate binding validation. Add the optional Cloudflare workflow-definitions entrypoint to host portable workflows and compiled agents with validated input, per-run dependency resolution, explicit dispatch authority and native replay/error semantics.
  
  Update CLI output, runnable examples, packed consumers and migration documentation together. Keep root Cloudflare declarations usable without installing the optional Feature Flags peer. See docs/module-api-migration.md for the new signatures and required application changes. This is a coordinated breaking change on the 1.x line; no compatibility aliases are retained.

### Patch Changes

- Updated dependencies [9a00506]
  - @velajs/vela@1.34.0

## 1.34.0

### Minor Changes

- b7c0142: Add the framework-free `transports/cloudflare` subpath for outbound Cloudflare
  Email Service bindings. Preserve structured recipients, bodies, reply-to and
  custom headers, redact provider failures while retaining their cause, and return
  submission tracking metadata without promising recipient delivery. Include a
  local Workers example composing native inbound email with existing queued mail.

## 1.33.0

### Minor Changes

- b7d0725: Remove obsolete contracts and backward-compatibility paths.
  
  Validation now requires Standard Schema or DTO descriptors. Decorated events require event definitions and use EventDispatcher; EventEmitter.emit always settles every matching callback. Remove token-only discovery, instance-based schedule views, ownerless entrypoints, disposed-container reuse, unmanaged scope finalization, and the `(.*)` middleware alias. Queue driver bind returns cleanup and enqueue after inline disposal rejects. Configure HTTP body caps through security.body.maxBytes.
  
  WebSocket clients must report admission with trySendRaw. Tiered caches require expiry-aware read/write methods; KV entries without expiry metadata miss. Aggregate specs use only aggregations, the default CRUD adapter can be undefined, and Studio discovers resources registered through Crud. Remove the Studio path alias, the mail envelope argument overload, the AI embedding resolver fallback, and the obsolete contentHash export.
  
  Storage encryption rejects invalid ciphertext; compression requires format metadata and a metadata-capable store.
  
  Update adapters, examples, tests, API snapshots and migration documentation to the current contracts.

### Patch Changes

- Updated dependencies [b7d0725]
- Updated dependencies [b7d0725]
  - @velajs/vela@1.33.0

## 1.32.0

### Minor Changes

- 1882d4f: `readInboundEmail(message, options?)` reads a platform inbound message (the SMTP envelope `from` and `to`, the raw `ReadableStream` and its `rawSize`), such as the `ForwardableEmailMessage` an `@OnEmail()` handler of `@velajs/cloudflare/email` receives, into an `InboundEmail`. A declared size over `limits.maxMessageBytes` is refused before reading and a longer stream is cancelled (`inbound_malformed`); the bytes are parsed by `parseInboundEmail` with the SMTP envelope as `envelope`. The options are `parseInboundEmail`'s less `envelope` (`ReadInboundEmailOptions`), and the message type is `InboundEmailMessage`. Authentication stays unverified unless the options supply trusted verdicts, so the default gate refuses such a message.
  
  **Behavior change:** an `@OnInboundEmail` handler failure, including one a scoped filter handles, is reported on the core `'email'` edge (`ErrorReportContext.edge`) instead of `'queue'`; `kind` stays `'mail:inbound'`. An `ExceptionHandler` that filters inbound mail failures by `edge === 'queue'` must match `'email'`.

### Patch Changes

- Updated dependencies [9dea818]
- Updated dependencies [524e422]
- Updated dependencies [a7d0912]
- Updated dependencies [04e7ac5]
- Updated dependencies [ff98301]
- Updated dependencies [38ab1e5]
- Updated dependencies [38ab1e5]
- Updated dependencies [9c1bd0b]
- Updated dependencies [e412fc8]
- Updated dependencies [bcdf5e3]
- Updated dependencies [d5a8c60]
  - @velajs/vela@1.32.0

## 1.31.0

### Minor Changes

- b227d22: Build `MailModule` on `defineModule` directly, with `queue` and `inbound` as its structural options (`MailStructuralOption`). The hand-written `forRoot`/`forRootAsync` wrappers and their process-wide reference-identity tables are removed; an inbound gate host still keys by the gate object.
  
  **Behavior change:** a mailer's instance key comes from its structural options, so two configurations that differ only in `from`, `transport` or `render` share a key and the second fails bootstrap instead of becoming another mailer. Give each additional mailer its own `key`. A `forRootAsync` factory that returns `queue` or `inbound` fails bootstrap with the engine's message (`MailModule.forRootAsync: the factory returned the structural option 'queue'`).

### Patch Changes

- Updated dependencies [0b8c649]
- Updated dependencies [1011653]
- Updated dependencies [088f4d4]
- Updated dependencies [f267c2f]
- Updated dependencies [dfe925c]
- Updated dependencies [fd11d20]
- Updated dependencies [748e4f8]
- Updated dependencies [096e259]
- Updated dependencies [fd11d20]
- Updated dependencies [3418c55]
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
  - @velajs/vela@1.31.0

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

- 9d5bccc: `MailModule` registers its own queue. With `queue` set, the mailer imports `QueueModule.registerQueue({ name, binding, consumer })` next to its `mail:send` consumer, so the application only imports `QueueModule.forRoot({ driver })`. The new `MailQueueOptions` accepts `binding`, the producer binding the driver sends through (a Wrangler `queues.producers[].binding` with `cloudflareQueues()`), and `consumer`, which pins the physical queue as in `registerQueue`. Native Cloudflare deliveries now reach the mail consumer through `cloudflareQueues()`.
  
  **Behavior change:** `QueueModule.forRoot({ queues: ['mail'] })` no longer exists; replace it with `QueueModule.forRoot({ driver })` and let `MailModule.forRoot({ queue: { name: 'mail', binding: 'MAIL_QUEUE' } })` register the queue. A mailer configured with `queue` now fails bootstrap when the application does not import `QueueModule.forRoot()`, instead of failing with `queue_required` on the first `queue()` call.
  
  The `queue_required` error of `MailService.queue()` now explains the fix: pass `queue: { name?, binding? }` to `MailModule.forRoot`, which registers the queue itself, and import `QueueModule.forRoot({ driver })` once in the root module.
- 4071cb7: A factory without parameters may omit `inject` in `BetterAuthModule.forRootAsync()`, `MailModule.forRootAsync()`, `StorageModule.forRootAsync()`, `RpcClientModule.registerAsync()` and `overrideProvider(token).useFactory({ factory })`, as in the `@velajs/vela` factories. A factory with parameters still names their tokens in `inject`, and a dependency tuple given as a type argument still needs a matching `inject`.
  
  `StorageModule.forRootAsync()` factories may return `{ driver, multipartGrantSecret }` instead of a bare driver, so the multipart grant secret comes through DI, for example from `ENV`, now that roots are static. The factory still runs once, on first use, or again on the next use until it succeeds; its secret takes precedence over `http.multipartGrantSecret` and is validated with the rest of the factory result on each such use, and multipart endpoints without any secret keep refusing every request. Adds the `StorageAsyncResult` and `StorageControllerOptions` types, and `createStorageController()` takes an optional token for the values it resolves per application.
  
  **Behavior change:** a multipart grant secret shorter than 32 bytes is a server configuration error instead of a client error. `StorageModule.forRoot()` throws for such an `http.multipartGrantSecret` when the module is set up, and a `forRootAsync()` factory that returns one fails every storage operation and multipart request until the factory returns a valid result, which the controller answers with a redacted 502 `upstream_error`. Multipart requests no longer answer 400 `invalid_request` with a message that names the setting.
  
  **Behavior change:** `MailModule.forRootAsync()` and `StorageModule.forRootAsync()` throw when called with a factory that declares parameters but no `inject`, naming the method, instead of running it with `undefined` arguments. `MailModuleAsyncOptions`, `StorageModuleAsyncOptions` and `RpcClientAsyncOptions` are type aliases instead of interfaces, so an interface can no longer extend them: intersect them instead (`RpcClientAsyncOptions<Inject> & { region: string }`). `MailModuleAsyncOptions.imports` is typed `ModuleImport[]`, so a caller that enables `exactOptionalPropertyTypes` omits it instead of passing `undefined`.

### Patch Changes

- e3bda2a: Module-level `@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters` and `@UseMiddleware` now run once per request when the same module classes are bootstrapped more than once in an isolate (per-environment rebuilds, Durable Object instances, tests). Previously every bootstrap added another copy to the module's controllers, so later applications wrapped responses twice and ran guards such as throttling twice.
  
  **Behavior change:** module-level components are resolved per application from the module instance that declares the controller instead of being copied onto the controller's metadata. `MetadataRegistry.propagateControllerComponents()` is removed, and `MetadataRegistry.getController()` returns only a class's own decorations. The static `ComponentManager.getScopedComponents(type, controller, handlerName)` from `@velajs/vela/internal` is removed; use the new `getScopedComponents(type, class, method, container, moduleId)` from `@velajs/vela` instead, which reads the declared entries, module-level ones included, without constructing them; `resolveScopedComponents()` and `resolveScopedComponentsAsync()` include them for the owning `moduleId` (or the class's only owner when it is omitted). The `@velajs/authz` authorization audit and `@velajs/mail` inbound dispatch recognize module-level components the same way.
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

### Patch Changes

- Updated dependencies [b99d71a]
  - @velajs/vela@2.0.0

## 1.0.2

### Patch Changes

- 735f7ad: Dispatch each owner-bearing inbound email entrypoint once. Preserve module
  expansion for legacy ownerless entries and reject owners outside the application.
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

## 1.0.1

### Patch Changes

- 26cea98: Move mail into the monorepo with checked Vela providers, explicit async injection
  tuples, module-owned inbound scopes and app-local queue routing. Preserve the
  portable pipeline and framework-free transports/testing exports. Reject empty
  authentication gates and malformed queued fields, snapshot inbound configuration
  and input bytes, and document the supported API and unimplemented native adapters.

## 1.0.0

### Major Changes

- 9ac1c73: Stop trusting message-supplied `Authentication-Results` by default. Inbound authentication now requires adapter-verified verdicts or an exact configured `authserv-id`; the configuration-only internal bypass is removed, result clauses are parsed without scanning quoted text, and authentication headers are quarantined from the public header map. Add secure message, body, header, and recipient ceilings across direct and queue delivery, and reject custom headers reserved for the mailer, transport, or receiving MTA.

  Key dynamic mail registrations by transport, renderer, gate, policy, and async-factory identity. Distinct equal-looking tenant configurations no longer deduplicate into the first registration, explicit-key rebinding is rejected, and multiple app-global inbound gates fail closed.

## 0.1.0

- Initial release.
