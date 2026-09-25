# @velajs/rpc

## 1.31.0

### Minor Changes

- f267c2f: Global guards run in deterministic phases, whatever order modules register them in: `authenticate` → `tenant` → `authorize` → `feature`. A guard declares its phase with `static readonly phase: GuardPhase` (an instance may carry its own `phase`); a guard without one runs in `feature`, and guards keep registration order within a phase. HTTP, WebSocket and RPC dispatch order the constructed guards, so a guard provided by a factory (`APP_GUARD` with `useFactory`) runs in the phase its instance declares; other transports call `orderGuardsByPhase` from `@velajs/vela/module-kit`. Global guards still run before controller and method guards. `ThrottlerGuard` and `FeatureFlagGuard` are feature guards, so throttling partitions by the identity an `authenticate`-phase guard verifies, and such a guard no longer has to be imported before `ThrottlerModule`.
  
  Each integration installs its guard globally (through the `defineModule` `global:` slot or an `APP_GUARD` provider under the guard's own token, so `overrideGuard(TenantGuard)` and `overrideGuard(CedarGuard)` in `@velajs/testing` reach the installed instance) and takes `guard: 'global' | 'none'`, defaulting to `'global'`: `BetterAuthModule` and `CloudflareAccessModule` authenticate, `TenantModule` admits the tenant, and `AuthzModule` (`PermissionGuard`, `RolesGuard`) and `CedarModule` authorize. `guard` is a structural option with that default, so `forRoot({ ... })` and `forRoot({ ..., guard: 'global' })` are one instance; with `forRootAsync`, pass it beside the factory. The per-phase markers stay: `@Public`/`@OptionalAuth`, `@TenantIgnored`/`@TenantOptional`, `@CedarPublic`. The installed `TenantGuard` and `CedarGuard` cover every application route, including routes in modules that do not import `TenantModule` or `CedarModule` (they admit or authorize through the installing module), whether or not the module is registered with `isGlobal`, and they also run on WebSocket, live-query and RPC entrypoints (see the behavior changes below); a route-level `TenantGuard` or `CedarGuard` in a module that cannot see its module answers 403.
  
  An integration package marks its own controller, which applications cannot annotate, with `SkipGuardPhases(['tenant', 'authorize'])` from `@velajs/vela/module-kit`: the global guards integrations install in those phases do not run for its routes. Only a guard that declares `static readonly skippable = true` is skipped, as `TenantGuard`, `PermissionGuard`, `RolesGuard` and `CedarGuard` do; other global guards run in every phase on these routes, as do authentication, feature and route guards. `skippable` belongs to the guard class, whoever registers it: an application guard that extends an integration guard inherits it, and declares `static override readonly skippable = false` to run on these routes too. The Better Auth handler and the `@velajs/storage` controller skip both phases; the GraphQL endpoint skips `authorize`, because resolvers authorize each field.
  
  To declare route metadata such as Cedar policy on generated CRUD controllers, which applications do not write, use the new `decorators` and `endpointDecorators` resource options of `@velajs/crud`.
  
  `RpcModule` and `rpcAdapter` run the `authorize` policy in the global `authorize` phase, before the other global authorize guards: after global authentication and tenant admission, so a policy can read the trusted identity those guards publish.
  
  **Behavior change:** `CloudflareAccessModule`, `TenantModule` and `AuthzModule` now install their guards globally. Remove `@UseGuards(CloudflareAccessGuard)`, `@UseGuards(TenantGuard)` and `@UseGuards(PermissionGuard, RolesGuard)` where the module now covers the route, or pass `guard: 'none'` and keep a fully route-level pipeline (a global guard runs before every route guard). Mark tenant-free routes with `@TenantIgnored()` or `@TenantOptional()`. `AUTHZ_OPTIONS` is typed as the new `AuthzModuleOptions`. Registrations of `CloudflareAccessModule`, `TenantModule`, `AuthzModule` and `CedarModule` are keyed by `guard` (and Cedar's `undeclared`) instead of by all their options, so a second registration with the same `guard` and other options, such as a feature module's own `AuthzModule` engine with other roles, fails bootstrap: give each additional registration its own `key`, and keep `guard: 'global'` on only one `AuthzModule`, `TenantModule` or `CedarModule` registration.
  
  **Behavior change:** `CedarModule`'s `globalGuard: false` is replaced by `guard: 'none'`, and `CedarGuard` denies (403) application routes without `@RequireResource()` or `@CedarPublic()`, in every module. Set `undeclared: 'allow'` to let them through as before. `undeclared` is structural, like `guard` (default `'deny'`): with `forRootAsync`, pass it beside the factory, which cannot return it.
  
  **Behavior change:** the guards `CloudflareAccessModule`, `TenantModule`, `AuthzModule` and `CedarModule` install run wherever the application's global guards run, not only on controller routes: on WebSocket gateway messages, on the check before each push to a socket (a gateway or live-query push, run with the gateway class), on the reserved `$live` frames that subscribe to and unsubscribe from live queries and send presence heartbeats (run with the framework's `LiveEngine` class, which applications cannot annotate) and on RPC procedures. `SkipGuardPhases` applies only to controller routes. With default options:
  
  - `CedarModule` (`undeclared: 'deny'`): a gateway message without `@RequireResource()` or `@CedarPublic()` answers an `exception` frame (`code: 'internal'`), pushes are not delivered, `$live` frames get no reply, and an undeclared RPC procedure answers a 403 failure frame. The guard @velajs/authz-cedar 1.30.0 installed let undeclared handlers through.
  - `TenantModule`: gateway messages, pushes and `$live` frames fail the same way, because a socket context has no request to select the tenant from. RPC procedures require a tenant and an authenticated identity, as routes do (400 without them).
  - `CloudflareAccessModule`: every gateway message, push and `$live` frame fails, in `mode: 'optional'` too, because the guard verifies HTTP requests only. RPC procedures require an Access identity, as routes do.
  - `AuthzModule`: handlers without `@Roles()` or `@RequirePermission()` pass; those declarations on gateway handlers and RPC procedures are now enforced.
  
  A guard failure on a `$live` frame or a push reaches only the error reporter, which does not log 4xx errors by default; a rejected presence heartbeat leaves the socket out of its room's presence roster. Mark gateway classes and RPC providers or procedures with `@CedarPublic()` or `@RequireResource()`, and with `@TenantIgnored()` or `@TenantOptional()`; a marker on the gateway class, not on a handler, also admits its pushes. Markers cannot reach `$live` frames: for live queries and presence, give `TenantModule` a `resolve` option that returns the tenant of a socket context (from the connection's verified identity, `normalizeWebSocketUpgradeIdentity(client.data)` from `@velajs/vela/websocket`), set Cedar's `undeclared: 'allow'`, or pass `guard: 'none'`. `CloudflareAccessModule` has no socket option: an application with gateways or live queries passes `guard: 'none'`, authenticates HTTP routes with `@UseGuards(CloudflareAccessGuard)` and sockets at upgrade with `CloudflareAccessUpgradeAuthenticator`; global guards run before route guards, so it applies the tenant and authorization guards on those routes too (`guard: 'none'` on their modules).
  
  **Behavior change:** The RPC `authorize` policy runs after global authentication and tenant guards instead of before every global guard. A policy that denied callers because the identity was not yet published now sees the identity an `authenticate`-phase guard publishes.
  
  **Behavior change:** an application's own global guard without a `phase` runs in `feature`, where @velajs/vela 1.30.0 ran every global guard in registration order. A custom global authentication guard, such as an `APP_GUARD` JWT guard, that does not declare `static readonly phase = 'authenticate'` now runs after the tenant and authorize guards the integrations install (`TenantGuard`, `PermissionGuard`, `RolesGuard` and `CedarGuard`) and after the RPC `authorize` policy, so they run without the identity it publishes, and it runs in import order relative to `ThrottlerGuard`. Declare `static readonly phase = 'authenticate'` on such a guard, and `'tenant'` or `'authorize'` on a custom global tenant or authorization guard.
- f267c2f: Every HTTP failure renders through one function, `renderHttpError(error, { catalog?, redactServerBodies? })`, exported from `@velajs/vela` with `getErrorStatus(error)`. It returns `{ status, body, redacted }`. Controller handlers, Vela middleware, the last-resort Hono `onError`, unmatched routes, request limits, RPC and GraphQL all derive their status and body there. Exception filters run first where the edge has a pipeline: controller handlers and RPC procedures (their scoped and global filters), GraphQL resolvers (the provider's filters and the `GraphqlModule` field filters), and Vela middleware, unmatched routes and request limits (global filters). The HTTP edges and RPC then apply the application's `ExceptionHandler.render` hook. The last-resort Hono `onError`, which receives errors thrown by raw Hono middleware and routes, runs no exception filters but applies the `ExceptionHandler.render` hook before rendering.
  
  - An exception owns its wire shape through `toResponse()`, which returns `{ status, body }` (`HttpErrorResponse`). `HttpException` returns an object response verbatim, as before, so a health check's 503 still ships as written; a string response takes the canonical `{ error: { code, message, details? } }` body. Only exceptions the `HttpException` constructor built, including subclasses such as `CrudException`, own a response: the constructor brands them. Any other thrown object with a `toResponse()` is an unknown error, reported and answered with a redacted 500, so a third-party error cannot choose its own status or body. `CrudException` renders its `{ success: false, error }` envelope through `toResponse()` and keeps its human-readable `message`. Errors thrown by raw Hono middleware reach only `onError`, which redacts an owned 5xx body to its status title, as RPC frames do.
  - `HttpException` and each subclass accept `options` (`{ details, cause }`). A 4xx sends `details` as `error.details`; a 5xx sends neither its text nor its details. `getDetails()` reads them.
  - Unmatched routes answer a JSON 404 (`{ error: { code: 'not_found', message: 'Not Found' } }`), including Workers built with `createCloudflareWorker`, and oversized bodies a JSON 413 (`payload_too_large`). These and the query-limit 400s are not reported. As in Nest, global exception filters receive them (`NotFoundException`, `PayloadTooLargeException`, `BadRequestException`), and a filter's plain result keeps their status.
  - A Hono `HTTPException` with a 4xx status renders its message in the canonical body on every edge, including controller handlers, where @velajs/vela 1.30.0 answered a redacted 500; one built with its own `res`, such as an auth challenge, keeps that response and its headers. Any other status below 500 renders as a redacted 500 unless the exception has its own `res`.
  - GraphQL maps a field error's status from the shared renderer, so branded `VelaError`s, Hono `HTTPException`s with a 4xx status and exception-owned responses reach the same public codes (`FORBIDDEN`, `NOT_FOUND`, …) as `HttpException`s, where @velajs/graphql 1.29.0 answered `INTERNAL_SERVER_ERROR` for any error that was not an `HttpException`. An RPC failure frame carries only `{ code, message, status }`. When the rendered body has `error.code` and `error.message` (the canonical body, or an exception-owned 4xx body with that member, such as the CRUD envelope), the frame keeps the message and the code, or the status's code when that code is malformed; otherwise it sends the status's code and a generic message. A frame coded `internal` always carries the generic message, and a 5xx owned body is redacted first.
  
  **Behavior change:** validation failures from `ValidationPipe` and `@Body(schema)` answer `{ error: { code: 'bad_request', message: 'Validation failed', details: { issues } } }`, and `@Endpoint` input failures the same body with the message `'Endpoint input validation failed'`, instead of `{ statusCode, message, errors }`. The thrown `BadRequestException` carries the issues in `getDetails()`.
  
  **Behavior change:** an exception filter's result is sent with `getErrorStatus(error)`, the exception's status (`HttpException.getStatus()` or `VelaError.status`) when it is 400–599, else 500, instead of 200. Return `{ status, body }` (exactly those keys) to set the status explicitly, or a `Response`. A filter that returns `undefined` no longer sends an empty 204: the error falls through to the default renderer. RPC applies the same rules to the status it keeps: a filter's plain result, which @velajs/rpc 1.30.0 ignored (the error fell through to the application's `ExceptionHandler.render` hook and the default frame, with the error's own code and message), now ends the call with a failure frame carrying that status's code and a generic message (`RPC request failed` for a 4xx), and `ExceptionHandler.render` does not run for the error. Return `undefined` from the filter to keep the default frame.
  
  **Behavior change:** an RPC failure caused by an exception-owned 4xx body that has `error.code` and `error.message`, such as `CrudException`'s `{ success: false, error: { code, message } }` envelope or an `HttpException` built with `{ error: { code: 'locked', message: 'Record locked' } }`, now carries that code and message: a `CrudException` 404 answers `{ code: 'NOT_FOUND', message: <its message>, status: 404 }`, where @velajs/rpc 1.30.0 answered `{ code: 'not_found', message: 'RPC request failed', status: 404 }`. An `HttpException` with a string response keeps its message and the status's code, as before. Update clients that match RPC error codes. GraphQL clients now see the status's public code (`FORBIDDEN`, `NOT_FOUND`, …) for branded `VelaError`s and 4xx Hono `HTTPException`s instead of `INTERNAL_SERVER_ERROR`.
  
  **Behavior change:** the last-resort Hono `onError` now applies the application's `ExceptionHandler.render` hook to errors thrown by raw Hono middleware and routes; @velajs/vela 1.30.0's `onError` rendered them without calling it. Exception filters still do not run there.
  
  **Behavior change:** `HttpException.getRawResponse()` is removed. Override `toResponse()` to own an exception's response, and call `renderHttpError(error)` to map an error to another transport.
- b227d22: Build `RpcClientModule` on `defineModule`; `name` and `binding` are its structural options (`RpcClientStructuralOption`).
  
  **Behavior change:** `RpcClientModule.register` and `RpcClientModule.registerAsync` are renamed `RpcClientModule.forRoot` and `RpcClientModule.forRootAsync`, with no alias. `forRootAsync` takes `name` and `binding` next to its factory, which returns the transport settings (`url`, `fetch`, ...); `RpcClientAsyncOptions` changes accordingly. The synchronous options no longer accept `imports`. A second configuration of a client name fails bootstrap; two registrations of one name under different keys still fail with the duplicate-client error.

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

- 4071cb7: A factory without parameters may omit `inject` in `BetterAuthModule.forRootAsync()`, `MailModule.forRootAsync()`, `StorageModule.forRootAsync()`, `RpcClientModule.registerAsync()` and `overrideProvider(token).useFactory({ factory })`, as in the `@velajs/vela` factories. A factory with parameters still names their tokens in `inject`, and a dependency tuple given as a type argument still needs a matching `inject`.
  
  `StorageModule.forRootAsync()` factories may return `{ driver, multipartGrantSecret }` instead of a bare driver, so the multipart grant secret comes through DI, for example from `ENV`, now that roots are static. The factory still runs once, on first use, or again on the next use until it succeeds; its secret takes precedence over `http.multipartGrantSecret` and is validated with the rest of the factory result on each such use, and multipart endpoints without any secret keep refusing every request. Adds the `StorageAsyncResult` and `StorageControllerOptions` types, and `createStorageController()` takes an optional token for the values it resolves per application.
  
  **Behavior change:** a multipart grant secret shorter than 32 bytes is a server configuration error instead of a client error. `StorageModule.forRoot()` throws for such an `http.multipartGrantSecret` when the module is set up, and a `forRootAsync()` factory that returns one fails every storage operation and multipart request until the factory returns a valid result, which the controller answers with a redacted 502 `upstream_error`. Multipart requests no longer answer 400 `invalid_request` with a message that names the setting.
  
  **Behavior change:** `MailModule.forRootAsync()` and `StorageModule.forRootAsync()` throw when called with a factory that declares parameters but no `inject`, naming the method, instead of running it with `undefined` arguments. `MailModuleAsyncOptions`, `StorageModuleAsyncOptions` and `RpcClientAsyncOptions` are type aliases instead of interfaces, so an interface can no longer extend them: intersect them instead (`RpcClientAsyncOptions<Inject> & { region: string }`). `MailModuleAsyncOptions.imports` is typed `ModuleImport[]`, so a caller that enables `exactOptionalPropertyTypes` omits it instead of passing `undefined`.
- bacaacd: Derive RPC failure codes for `HttpException`s from the core catalog. 5xx messages remain
  redacted.
  
  **Behavior change:** a 406, 408, 412 or 428 `HttpException` now fails with the code
  `not_acceptable`, `request_timeout`, `precondition_failed` or `precondition_required` instead of
  `bad_request`, and a 4xx failure carries the catalog's `hint` and `docsUrl` for its code when
  the application catalog defines them. Clients that match on `error.code` must handle the new
  codes.

### Patch Changes

- Updated dependencies [07d1713]
- Updated dependencies [bacaacd]
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
  - @velajs/errors@1.23.0

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

## 1.1.0

### Minor Changes

- 04dba06: Add optional schema-inferred method RPC with a portable HTTP/service-binding client and a Vela server adapter. Preserve module ownership, async validation, HTTP guards and managed request lifetime; reject duplicate procedures and malformed envelopes. Include explicit exposure policy, bounded client deadlines, opt-in idempotent retries, browser isolation checks and native Workers coverage.

### Patch Changes

- 20c4895: Validate RPC route paths with linear boundary, separator and character checks, avoiding excessive regex backtracking on long invalid paths. Preserve concrete absolute paths with nonempty ASCII identifier segments and reject trailing or repeated slashes and disallowed characters.
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
