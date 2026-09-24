# @velajs/mail

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
