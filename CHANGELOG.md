# Changelog

## 1.2.0 (2026-05-01)

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
