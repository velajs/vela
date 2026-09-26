# Changelog

## 1.34.0

### Minor Changes

- 9a00506: Align module APIs with instance ownership: shared facilities use forRoot, local and named services use register, and Queue, I18n and Seeder contribute declarations through forFeature. Remove replaced APIs. Local registrations receive independent identities; reused definitions share within an application, and explicit keys retain conflict checks.
  
  Require applications to attach exported guards and interceptors explicitly. Remove automatic installation and guard options while preserving policy ownership, request scope, phase ordering, testing overrides and integration-route exemptions. Keep translation contributions and mutable runtime configuration isolated per application, and return runtime-only settings from async factories. Storage separates structural httpController mounting from runtime http options.
  
  Add schema-first GraphQL resolver and parameter decorators with exact provider ownership, endpoint selection and duplicate binding validation. Add the optional Cloudflare workflow-definitions entrypoint to host portable workflows and compiled agents with validated input, per-run dependency resolution, explicit dispatch authority and native replay/error semantics.
  
  Update CLI output, runnable examples, packed consumers and migration documentation together. Keep root Cloudflare declarations usable without installing the optional Feature Flags peer. See docs/module-api-migration.md for the new signatures and required application changes. This is a coordinated breaking change on the 1.x line; no compatibility aliases are retained.

### Patch Changes

- Updated dependencies [9a00506]
  - @velajs/vela@1.34.0

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

- 586be4f: Provider overrides and `useMocker` apply to the registered module graph before any module class is built. `useMocker` therefore supplies the constructor dependencies of a module class that implements `NestModule`, and `overrideProvider()` replaces them, where compiling used to fail with `UnresolvedDependencyError` or build the module with the original provider; its `configure(consumer)` sees the replacements too.
  
  **Behavior change:** this release requires `@velajs/vela` 1.32.0, and its peer range becomes `^1.32.0`. It applies overrides through a bootstrap step an earlier core does not run, so on core 1.31 `overrideProvider()` and `useMocker` would silently not apply. Upgrade the core and `@velajs/testing` together.

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

- 2c92243: Add Nest's `overrideModule(Module).useModule(Replacement)` and `useMocker(factory)` to the testing module builder; as in Nest, the `OverrideModule` step `overrideModule()` returns is exported as a type. `overrideModule` loads the replacement (a module class or a `DynamicModule`) wherever the graph imports the module class, any `DynamicModule` of it, or exactly the `DynamicModule` passed, including through `exports: [Module]` re-exports, without modifying module metadata. `useMocker` calls `factory(token)` once for each token a constructor or factory injects that no visible provider satisfies, after the overrides and before anything is constructed, and registers the value in each module that needs it; optional parameters, `ModuleRef`, `InjectionToken` defaults and provided or overridden tokens are left alone. As in Nest, a falsy result supplies nothing: the dependency stays unresolved and `compile()` rejects with `UnresolvedDependencyError`.
  
  `Test.createTestingModule(metadata, options)` accepts every `VelaFactory.create` option (`globalPrefix`, `security`, `middleware`, `diagnostics` besides `env` and `adapters`): `TestingModuleOptions` extends `VelaCreateOptions`.

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
- efc0876: `Test.createTestingModule(metadata, { env, adapters })` seeds the application's `ENV` and binds runtime adapters through the same bootstrap path as `VelaFactory.create`: adapter `configureContainer`, request middleware, client-IP resolver and lifecycle hooks all apply. `moduleRef.fetch()` and the HTTP and SSE builders send each request with the seeded `env` as the Hono `c.env` unless `fetch(request, env)` passes one explicitly, so an adapter that binds requests to its environment, such as `cloudflareAdapter({ env })` given the same `env`, accepts them. The WebSocket builder keeps the Node transport's own request bindings. `overrideProvider(ENV).useValue(...)` replaces the environment for every module, with or without a seeded `env`. The `TestingModuleOptions` type is exported.
- a5d5615: Add `TestingModule.resolveInRequest(token, init?)`. It resolves the token in a fresh request scope seeded from an optional `RequestInit` plus `url`, and keeps that scope open until `close()` so the returned instance and its request dependencies stay usable. `runInRequestScope(callback, init?)` accepts the same request init, and the `TestRequestInit` type is exported.
  
  **Behavior change:** `TestingModule.get()` throws for request-scoped providers and points to `resolveInRequest()`, instead of constructing them on the root container.

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

## 1.23.0

### Minor Changes

- 0765aaa: Use shared application finalization in testing, recalculate request scope after
  provider overrides, and dispose resources on failed startup and shutdown. Await
  concurrent disposal and managed test scopes. Add onClose fixture cleanup and close
  Node WebSocket test servers with their owning testing module.
- 0ef063e: Add createTestHttpClient for live and injected Web-API request transports.
  Validate test response bodies using shared async-aware Standard Schema and
  legacy parsing, preserving inferred transformed outputs and existing parser calls.

### Patch Changes

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

Typed override descriptors and production-equivalent request and environment scope.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.0.0

### Major Changes

- 02bb42e: Target the published Vela 1.21 security release and use Vela's production bootstrap primitive so request context, global providers, and request-scoped test execution cannot drift from the real runtime. Standalone CI no longer relies on a sibling `link:../vela` checkout.

## 0.6.0

### Minor Changes

- 5097ee4: Add `@velajs/testing/eval`: a small, model-agnostic harness for scoring the output of any string-producing function. Ships heuristic scorers (`exactMatch`, `contains`, `keyword`, `regex`), an `llmScorer` LLM-as-judge whose `judge` callback is injected (no AI SDK dependency, fails soft on unparseable replies), and `evaluate(dataset, run, scorers)` which returns per-case reports plus a per-scorer and overall aggregate.

## 0.5.1

### Patch Changes

- 647fd5f: Modernize the package build, validation, and release toolchain.

## 0.3.0 (2026-07-04)

- `ComponentManager.init` call removed; provider overrides use the supported `Container.replaceProvider`; registers `DiscoveryService` mirroring bootstrap. Requires `@velajs/vela >=1.11.0`.

## 0.2.1 (2026-05-14)

### Fixes

- **`compile()` now replicates `bootstrap()`'s global token setup.** Registers `Container`, `ModuleRef`, and `REQUEST_CONTEXT` as global tokens (the last is the canonical seam for the per-request bag that `RouteManager.setRequestInstance` populates). Marks `APP_GUARD/PIPE/INTERCEPTOR/FILTER/MIDDLEWARE` as global so multi-provider pipeline registration via `bindAppProviders` resolves cleanly. Before this fix, guards / services that injected `REQUEST_CONTEXT` (the documented `@CurrentUser` lazy-decorator pattern) crashed at request time with "REQUEST_CONTEXT can only be resolved inside a request". New test pins the behavior end-to-end.
- **Overrides now win for controller-internal constructor injection.** Pre-registering an override at the root container's `__root__` bucket only beat framework-internal lookups (no `requestingModuleId`). Controller constructor injection passes the controller's module id, which finds the module's own registration before the root override and short-circuits. The builder now post-processes after `loader.load()` and overwrites the registration in every module bucket that already holds the token.

### Breaking changes

- **`@velajs/vela` peer bumped to `>=1.6.0`.** Needs `REQUEST_CONTEXT` and `createLazyParamDecorator` re-exports (added in vela 1.6.0).

## 0.2.0 (2026-04-30)

Bugs fixed, rebuilt on `@velajs/vela/internal`, no more `reflect-metadata` dep.

### Fixes

- **Provider override shape was wrong.** `overrideProvider(token).useValue(v)` constructed `{ token, useValue }` but vela's container reads `{ provide, useValue }`. The misleading `as ProviderOptions` cast hid this; nothing actually overrode. Fixed.
- **`useClass` now uses the container's native `useClass` path** instead of the bogus `useFactory: () => new cls()` workaround. The previous comment claimed `Container.registerOptions` doesn't read `useClass` — it does (`vela/src/container/container.ts`).
- **`loader.resolveAllInstances()` is now awaited.** Was called synchronously even though vela's signature is async; lifecycle hooks fired before instance resolution finished.
- **APP\_\* token wiring uses vela's canonical `bindAppProviders` helper.** Replaces the five duplicated `useGlobalGuards/Pipes/Interceptors/Filters/Middleware(container.resolve(APP_*))` blocks that handled only the single-value case (vela switched to array form months ago). Now stays in lockstep with `VelaFactory.create` automatically.

### Breaking changes

- **`@velajs/vela` peer bumped to `>=1.1.0`.** The `optional: true` flag is removed — the package is unusable without vela.
- **`reflect-metadata` dependency removed.** Drop `import 'reflect-metadata'` from your test setup files; vela's built-in polyfill is sufficient.
- **`prepublishOnly` switched from `bun run` to `pnpm run`** to match the rest of the workspace.

### Internal

- **Rebuilt on `@velajs/vela/internal`** for framework primitives (`MetadataRegistry`, `Container`, `RouteManager`, `ModuleLoader`, `ComponentManager`, `VelaApplication`, `bindAppProviders`). Public types still come from `@velajs/vela`.
- **`bun.lock` deleted** — pnpm is the source of truth.

### Migration

```diff
- import 'reflect-metadata';
  import { describe, it, expect } from 'vitest';
  import { Test } from '@velajs/testing';

- @Module({
-   providers: [{ token: SomeToken, useValue: 'x' }],
- })
+ @Module({
+   providers: [{ provide: SomeToken, useValue: 'x' }],
+ })
  class TestModule {}
```

(The `token` → `provide` change applies to your `@Module()` providers, not just to overrides — vela's container has always read `provide`. The previous shape silently no-op'd.)

## 0.1.0 (2026-02-20)

Initial release.

- `Test.createTestingModule()` builder.
- `overrideProvider/Guard/Pipe/Interceptor/Filter` with `useValue/useClass/useFactory`.
- `TestingModule` with `get()`, `createApplication()`, `close()`.
