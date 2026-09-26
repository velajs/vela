# Changelog

## 1.33.0

### Minor Changes

- 9a00506: Align module APIs with instance ownership: shared facilities use forRoot, local and named services use register, and Queue, I18n and Seeder contribute declarations through forFeature. Remove replaced APIs. Local registrations receive independent identities; reused definitions share within an application, and explicit keys retain conflict checks.
  
  Require applications to attach exported guards and interceptors explicitly. Remove automatic installation and guard options while preserving policy ownership, request scope, phase ordering, testing overrides and integration-route exemptions. Keep translation contributions and mutable runtime configuration isolated per application, and return runtime-only settings from async factories. Storage separates structural httpController mounting from runtime http options.
  
  Add schema-first GraphQL resolver and parameter decorators with exact provider ownership, endpoint selection and duplicate binding validation. Add the optional Cloudflare workflow-definitions entrypoint to host portable workflows and compiled agents with validated input, per-run dependency resolution, explicit dispatch authority and native replay/error semantics.
  
  Update CLI output, runnable examples, packed consumers and migration documentation together. Keep root Cloudflare declarations usable without installing the optional Feature Flags peer. See docs/module-api-migration.md for the new signatures and required application changes. This is a coordinated breaking change on the 1.x line; no compatibility aliases are retained.

### Patch Changes

- Updated dependencies [9a00506]
  - @velajs/vela@1.34.0

## 1.32.0

### Minor Changes

- 3cc469d: Preserve native Flagship evaluation reasons, variants and error codes through optional driver detail methods and Studio responses. Value-only providers now report UNKNOWN instead of STATIC; native context accepts only scalar attributes, and route guards deny all evaluation errors. Existing object-validation callback signatures are unchanged.
  
  Add the optional crypto/cloudflare SecretsStoreKeyProvider for immutable, versioned AES-KW key material, with explicit per-instance caching, refresh, retry and rotation using retained decryption keys. Secrets Store supplies material for local Web Crypto; it is not a remote KMS.

## 1.31.0

### Minor Changes

- b227d22: Add the structural `guard: 'global' | 'none'` option, the same option the authentication, tenant and authorization modules take. `'global'`, the default, registers `FeatureFlagGuard` application-wide, so every `@FeatureFlag()` route is gated without `@UseGuards` and a flagged route is never reachable ungated; `'none'` gates only the routes that declare `@UseGuards(FeatureFlagGuard)`. Any other value throws when `forRoot()` or `forRootAsync()` is called.
  
  **Behavior change:** `isGlobal: true` no longer registers `FeatureFlagGuard` as an `APP_GUARD`; it only makes the module global, as on every module. The app-wide guard is now registered by default instead, whatever `isGlobal` says. `@UseGuards(FeatureFlagGuard)` is redundant under it and evaluates the flag a second time: remove it, or pass `guard: 'none'` to keep gating per route with `@UseGuards(FeatureFlagGuard)`.
  
  `FeatureFlagGuard` declares the `feature` phase (`static readonly phase = 'feature'`), so the global guard runs after the authentication, tenant and authorization guards whatever the import order, as @velajs/vela 1.31.0 orders global guards by phase.
  
  **Behavior change:** the app-wide guard runs wherever the application's global guards run, including WebSocket gateway messages and RPC procedures, so a `@FeatureFlag()` there is enforced without `@UseGuards`. A socket message has no request context to evaluate the flag for, so a `@FeatureFlag()` on a gateway handler rejects every message with an `exception` frame, even when the flag is on, and one on the gateway class also stops the gateway's pushes and live-query subscriptions. Keep flags on HTTP routes and RPC procedures, or pass `guard: 'none'`.
  
  `guard` defaults to `'global'` as a structural default, so `forRoot({ manifest })`, `forRoot({ manifest, guard: 'global' })` and `forRoot({ manifest, lazy: true })` (the module is lazy by default) are one instance with one app-wide guard. With `forRootAsync`, pass `guard` beside the factory.
  
  **Behavior change:** registrations are keyed by `guard` instead of by all their options, so a second `FeatureFlagsModule` with the same `guard` and other drivers or another manifest fails bootstrap instead of becoming another instance. Give each additional registration its own `key`.
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
  - @velajs/vela@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/vela@2.0.1

## 2.0.0

Parser-backed flag values and the checked Vela provider contracts.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.0.0

### Major Changes

- 588bd9f: Accept only literal boolean driver results, use own-property manifest lookup, preserve trusted identity fields, and make guards fail closed when context or evaluation is unavailable.

## 0.1.1

### Patch Changes

- 2b92134: Modernize the package build, validation, and release toolchain.

## 0.1.0

Initial release.

- Driver-based feature flags for Vela, authored purely on the public API
  (`defineModule`, `Reflector`, guards) — edge-pure, no `node:*`/`Buffer`/`process`.
- `FeatureFlagDriver` contract + in-package `MemoryFlagDriver` (default driver and test fake).
- `FeatureFlagsService`: manifest defaults, never-throw evaluation (`getBoolean/String/Number/Object`
  Value/Details), immutable `use(driver)`, `all()`, and a per-request `context` merge.
- `FeatureFlagsModule` (`defineModule`, `lazy: true`) with `forRoot`/`forRootAsync` and an
  `isGlobal` app-wide guard option.
- `@FeatureFlag(key, { onDisabled })` + `FeatureFlagGuard` to hide routes (404) or forbid them (403).
- `@velajs/feature-flags/testing` subpath: memory driver helpers + `createTestFeatureFlags()`.
