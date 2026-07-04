# Changelog

## 1.12.0 (2026-07-04)

The module-model release: one blessed authoring path plus public kernel
extension points, so feature modules (websocket, storage, queue, …) are built
entirely on the public API. See `MODULE_AUTHORING.md` for the author contract.
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

- **`createLazyParamDecorator((data, ctx) => T)`.** Custom parameter decorators whose factory runs the *first time the handler reads a property on the resolved value* — not during argument extraction. Vela's argument resolver runs before guards by design (`extract args → guards → handler`), which means a `createParamDecorator` factory that depends on guard-populated state observes an empty slot. The lazy variant returns a `Proxy` whose traps invoke the factory on demand; the `get` trap short-circuits `prop === 'then'` so `await value` does not consider the proxy a thenable and therefore does not trigger eager resolution. Method results are auto-bound to the resolved real target so detached calls keep `this`; `ownKeys` + `getOwnPropertyDescriptor` are implemented so `JSON.stringify(value)` works after one access. Exported from the root barrel and from `@velajs/vela/internal` via the same surface as `createParamDecorator`. Documented in README under *Custom parameter decorators with deferred resolution*.

### Changed

- **Exception-filter chain now catches errors thrown inside vela-attached middlewares.** Previously the `APP_FILTER` / `@UseFilters` chain only handled errors thrown from `@Controller` handler methods; errors from middlewares (global, `MiddlewareConsumer.apply(...).forRoutes(...)`, and per-route attached) bypassed the chain and surfaced as Hono's outer 500. They now flow through the same filter resolution as handler exceptions, with a synthesized `ExecutionContext` whose `getClass()` returns the `VelaMiddlewareHost` marker and whose `getHandler()` returns the `Symbol.for('vela.middleware')` sentinel — `getType()` stays `'http'` for NestJS parity. Only global filters apply at the middleware boundary (per-handler `@UseFilters` requires a controller call frame); for thrown `HttpException`s with no catching filter, the chain renders the exception's own response/status (matching handler-thrown semantics). Non-`HttpException` throws with no catching filter re-throw to preserve the existing default-500 path. Non-throwing middleware paths (returning a `Response`, calling `await next()`, resolving a promise) are byte-identical to before.

## Unreleased

A sanctioned per-request injectable lands as a framework primitive, the metadata-store unification finally has its regression tests, and dynamic module identity becomes consistent — closing the last open audit item.

### New

- **Dynamic module identity is now first-class** (audit #2 — last open item, fully closed). `DynamicModule` gains an optional `key?: string`; module authors call `key: stableHash(options)` inside `forRoot()` so two distinct option sets register as distinct module instances. The DI container is bucketed per-module (`Map<moduleId, Map<Token, Registration>>`) so the same logical token can have distinct registrations in different buckets — e.g., `imports: [CacheModule.forRoot({ttl:60}), CacheModule.forRoot({ttl:120})]` now actually produces two reachable cache configs instead of silently dropping one. A consumer module that imports both throws `MultipleProvidersFoundError` with both candidate ids in the message; resolve only one and the ambiguity disappears. `[HttpModule, HttpModule.forRoot({base:X})]` registers both and the loader emits a diagnostic warning. `createModuleRef()` is removed — module authors use `{module: RealClass, key}` directly. New helpers `defineDynamicModule()` and `stableHash()` are exported from the root.

  Pre-fix this swallowed configuration silently in two places: same-class `forRoot` calls collided at `processedModules.has(class)`, and synthetic-class-per-call patterns (the old `HttpModule`) collided at the container's `if (!has(token))` provider guard. Both guards are gone.

- **`REQUEST_CONTEXT` injectable.** A request-scoped primitive carrying a stable `id` (mirrored from inbound `x-request-id` if present, else `crypto.randomUUID()`), `receivedAt`, the raw `Request`, the Hono `Context`, and a typed `set/get/has` bag for cross-cutting metadata. Seeded by `RouteManager` into each per-request child container; resolves through `@Inject(REQUEST_CONTEXT)` from any request-scoped service. No `AsyncLocalStorage` — edge-runtime contract intact (verified live under workerd via `pnpm test:workers`).

  ```ts
  import { Inject, Injectable, Scope, REQUEST_CONTEXT } from '@velajs/vela';
  import type { RequestContext } from '@velajs/vela';

  @Injectable({ scope: Scope.REQUEST })
  class TenantResolver {
    constructor(@Inject(REQUEST_CONTEXT) private readonly ctx: RequestContext) {}
    resolve() {
      return this.ctx.hono.req.header('x-tenant') ?? 'default';
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

- **`Container` constructor accepts `ContainerOptions`** (`{ diagnostics? }`). Threads `requestingModuleId` through `resolve` / `resolveAsync` / `resolveAll`. Per-module scopes are tracked via `registerScope`; framework-internal globals via `markGlobalToken`. `providerOrigin: Map<Token, string>` records each provider's declaring module so constructor injections resolve from the *class's* module, not the caller's. Visibility enforcement runs whenever a `requestingModuleId` is supplied — there is no on/off switch.

- **`ModuleLoader` registers a `ModuleScope` per module** before recursing into imports — `localProviders` includes the module class itself (so `NestModule.configure()` resolution stays inside its own scope), controllers, and every provider token. Synthetic `APP_*` tokens are marked global at mint time so RouteManager's request-time resolutions (no requester) keep working.

- **`createChild()` shares container state by reference** (providers, scopes, globals, providerOrigin); `createDetached()` copies providers + providerOrigin and shares scopes + globals. Re-registering a token on a detached container without a moduleId clears any stale `providerOrigin` so sandbox-local registrations don't inherit a misleading owner.

- **`resolveAsync` factory branch now unwraps `ForwardRef` in `inject`** (mirroring the sync `resolveFactory`). Previously asymmetric — sync path worked, async path silently failed during `loader.resolveAllInstances` and was swallowed by the discovery `try/catch`.

- **Dropped unused `Container.parent` field** (audit #10). Was assigned in `createChild()` but never read.

- **Bootstrap consolidated into `src/factory/bootstrap.ts`** — `VelaFactory.create` no longer hand-rolls the APP_* / consumer-middleware / global-prefix wiring sequence. Net code reduction in `factory.ts`.

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
- **One `bindAppProviders` helper** (`pipeline/app-providers.ts`). Implements the NestJS APP_* provider convention in one place; replaces 5× duplicated APP_* wiring blocks across `factory.ts` and `testing.builder.ts`.
- **One module-graph walk** (`module/graph.ts`: `collectControllers`). Replaces the duplicate implementation in `openapi/document.ts`.
- **schedule/event-emitter/openapi decorators** now use `MetadataRegistry.appendCustomClassMeta`/`appendCustomHandlerMeta` instead of direct `Reflect.defineMetadata` calls.
- **Stub `pnpm-workspace.yaml` and `bunfig.toml` deleted** — they only set `onlyBuiltDependencies`, which lives in `package.json#pnpm`. `bun.lock` deleted; pnpm is the source of truth.

## 0.10.0 (2026-04-28)

Edge-runtime audit and AI-drift cleanup.

### Breaking changes

- **Schedule module split.** `ScheduleExecutor`, `SCHEDULE_MODULE_OPTIONS`, and `ScheduleModuleOptions` are no longer exported from `@velajs/vela`. The `setInterval`-based timer executor moved to a new opt-in sub-export at `@velajs/vela/schedule-node`. Consumers on Node or Bun should now do:

  ```ts
  import { ScheduleNodeModule } from '@velajs/vela/schedule-node';

  @Module({ imports: [ScheduleNodeModule.forRoot()], providers: [JobsService] })
  class AppModule {}
  ```

  `ScheduleModule.forRoot()` is now metadata-only — `enableTimers` is no longer accepted (drop the option entirely). `ScheduleModule.forRootAsync()` was removed (no options to async-resolve).

  Edge runtimes without `setInterval` (Cloudflare Workers, etc.) should continue to use platform cron triggers — `@velajs/cloudflare` ≥ 0.2.0 dispatches core `@Cron` jobs via its `scheduled()` handler.

- **TypeScript enums replaced with `as const` objects** for `HttpMethod`, `ParamType`, `Scope`, `RequestMethod`, and `LogLevel`. Value access (`HttpMethod.GET`) keeps working; type-position usages (`: HttpMethod`) keep working via same-name type aliases. Code that imported the enum *type* with structural assumptions about enum runtime shape may need adjustment.

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
