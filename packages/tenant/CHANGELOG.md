# @velajs/tenant

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
- 096e259: Declarations on an ancestor class apply to the classes that extend it, as reflect-metadata resolves them in Nest. In @velajs/vela 1.30.0 every reader looked only at the concrete class. Route decorators (`@Get()`, `@Post()`, …) are still read from the controller class itself, unlike Nest: a method an ancestor routes is not mounted on the subclass. Route an inherited method on the subclass, for example `Get('list')(Sub.prototype, 'list', descriptor)`.
  
  - Class metadata applies to a subclass through every `Reflector` form (`get`, `getClass`, `getAll`, `getAllAndOverride` and `getAllAndMerge`, with an execution context, `context.getClass()` or the `[context.getHandler(), context.getClass()]` list): the controller's own, else the nearest ancestor's, so `@Roles(['admin'])` on an abstract base controller guards every controller that extends it.
  - Method metadata an ancestor declares on a method the controller inherits without overriding, such as one it routes with `Get()(Sub.prototype, 'list', descriptor)`, applies through every `Reflector` form too: the nearest declaration wins, the controller's own, else the nearest ancestor's. A method the controller overrides reads only its own declarations, and metadata one controller declares on a shared method never applies to a sibling.
  - Class-level `@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters` and `@UseMiddleware` on an ancestor run for the subclass on every transport, the root class's first and the subclass's own last. On an inherited method, the method-level enhancers each ancestor declares run before the controller's own, and `@Serialize` and `SkipGuardPhases` read the nearest declaration. The module loader registers the enhancer classes a class inherits, as it does its own.
  - Guards that read route metadata, such as `AuthGuard`, `RolesGuard`, `PermissionGuard`, `TenantGuard`, `CedarGuard`, `FeatureFlagGuard` and `ThrottlerGuard`, enforce inherited requirements, and `authorizationAudit()` and `auditCedarRoutes()` read declarations as the guards do. `CacheModule` checks `@CacheResponse` at bootstrap as `CacheInterceptor` reads it, and `ThrottlerModule` checks `@Throttle()` as `ThrottlerGuard` reads it, inherited declarations included, so an invalid inherited declaration, such as tags without an invalidation store or a throttler the module does not declare, fails bootstrap instead of every request.
  
  **Behavior change:** class metadata and class-level enhancers an ancestor declares, and the metadata, method-level enhancers, `@Serialize` and `SkipGuardPhases` an ancestor declares on a method a controller inherits unchanged, now apply to the classes that extend it. Requirements such as `@Roles()`, `@RequirePermission()` or `@RequireResource()` there are enforced, where the routes previously ran without them. Opening markers apply the same way: an inherited `@Public()`, `@OptionalAuth()`, `@TenantIgnored()`, `@CedarPublic()`, `@SkipThrottle()` or `SkipGuardPhases` now opens or relaxes routes that previously required authentication, tenant admission, Cedar authorization or throttling. Remove a declaration from the ancestor, or override the method in the controller, where a subclass must not inherit it.

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

- 4071cb7: The built-in guards inject the application `Reflector` instead of constructing their own: `AuthGuard` (`@velajs/better-auth`), `FeatureFlagGuard` (`@velajs/feature-flags`), `PermissionGuard` and `RolesGuard` (`@velajs/authz/vela`), `TenantGuard` (`@velajs/tenant/vela`) and `CedarGuard` (`@velajs/authz-cedar/vela`). `PermissionGuard`, `RolesGuard` and `TenantGuard` are now injectable, so `@UseGuards()` builds them in the declaring module through DI, like any provider.
  
  **Behavior change:** each guard takes the `Reflector` as a constructor parameter, after any dependencies it already had: `new PermissionGuard(reflector)`, `new RolesGuard(reflector)`, `new TenantGuard(reflector)`, `new CedarGuard(reflector)`, `new AuthGuard(auth, options, reflector)` and `new FeatureFlagGuard(flags, reflector)`. Code that constructs a guard itself, such as `app.useGlobalGuards(new TenantGuard(app.get(Reflector)))` or a unit test, passes the application's `Reflector` or a `new Reflector()`, and a subclass that declares its own constructor passes it to `super()`. A guard class passed to `app.useGlobalGuards()` is built through DI only when a module registers it, including the copy a module registers for a `@UseGuards()` reference; otherwise pass an instance or register it as `{ provide: APP_GUARD, useClass: PermissionGuard }`. Guards resolved through DI need no change.

### Patch Changes

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

## 1.24.1

### Patch Changes

- c5a3cb0: Preserve authentication payload through verified tenant admission while retaining
  invalidation on expiry, clear and reauthentication. Add explicit HTTP-backed
  execution-context identity binding for custom dispatchers, and add a redacting
  Secret value with runtime-private signing
  credentials. Existing authentication and signing entrypoints remain compatible.
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

## 1.24.0

### Minor Changes

- fe7587f: Add Standard Schema validation and operation contracts, authoritative tenant admission and audited persistence, optional Cedar authorization with exact query plans, and Web Crypto envelope/field/file encryption. Complete compound CRUD identifiers, parent scopes, structured predicates, signed cursors, page projections and post-commit delivery. Add transactional memory and Durable Object SQLite adapters, with D1/Workers and PostgreSQL conformance coverage.

### Patch Changes

- Updated dependencies [fe7587f]
  - @velajs/vela@1.24.0

## Unreleased

- Add the portable edge capability and optional integrations described in the package README.
