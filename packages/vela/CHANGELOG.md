# Changelog

## 1.29.0

### Minor Changes

- 07d1713: Bring config namespaces to the NestJS shape. `ConfigModule.forFeature(namespace)` provides one `registerAs` namespace to the importing module, lazily, and merges it into the application's `ConfigService`. A namespace's `KEY` has one owner however it is loaded: `forFeature()` and `forRoot({ load })` of the same namespace (including a global `forRoot`) share one lazy provider, so feature modules resolve it without a `MultipleProvidersFoundError` and its factory runs once. Another namespace object registered under the same name is reported as a module identity collision. `ConfigService<T>` takes the loaded config shape (for example `ConfigService<ConfigShape<[typeof dbConfig]>>` in a constructor) and checks `get`/`getOrThrow` dot paths and their value types against it; `get(path, default)` returns the value type. Without `T`, reads stay `unknown`. Path expansion stops at a fixed depth, so recursive shapes stay cheap to type-check.
  
  **Behavior change:** `registerAs(namespace, envToken, factory)` becomes `registerAs(namespace, factory)`. The factory receives the application's `ENV` (`VelaEnv`) instead of a caller-supplied token; reading the namespace throws a clear error when no runtime seeded ENV. Remove the token argument and read bindings from the factory's `env` parameter, validating each value.
  
  **Behavior change:** `ConfigType` now means the shape of one namespace, as in NestJS: `ConfigType<typeof dbConfig>`. It replaces `InferConfigType`, which is removed with no alias. The previous tuple mapper `ConfigType<[typeof a, typeof b]>` is renamed `ConfigShape<[typeof a, typeof b]>`.
- db18d3a: Add `scope` to `@Controller` options, so `@Controller({ path, scope: Scope.REQUEST })` declares a request-scoped controller.
  
  **Behavior change:** Class decorators record a scope only when one is passed. `@Controller`, `@WebSocketGateway` and `@Seeder` no longer reset the class to singleton, so `@Injectable({ scope })` takes effect whichever side of them it is written on; a class that declares no scope is still a singleton. Declaring two different scopes on one class, for example `@Controller({ scope: Scope.REQUEST })` with `@Injectable({ scope: Scope.TRANSIENT })`, now throws when the class is decorated instead of letting decorator order pick one.
- 07d1713: Add a framework-owned runtime environment. `ENV` is a global `InjectionToken<VelaEnv>` with no default, `InjectEnv()` injects it (`constructor(@InjectEnv() env: VelaEnv)`), and `VelaEnv` is an empty interface that runtime packages augment through declaration merging. A runtime seeds ENV once per application: `VelaFactory.create(root, { env })` and `bootstrap(root, { env })` accept the environment object (a Node host may pass `process.env` from its own entrypoint), and a `RuntimeAdapter` can register it in `configureContainer`. A non-object `env` is rejected at bootstrap.
  
  **Behavior change:** `CONFIG_ENV` is removed, with no alias. Seed the environment through `ENV` instead (the `env` option, a runtime adapter, or `@velajs/cloudflare`). `UrlGeneratorService`, `SignedUrlGuard`, `InternalDispatcher` and `SignedInvocationGuard` now read a string `URL_SIGNING_SECRET` from ENV when no explicit secret or `URL_SIGNING_SECRET` provider is set. ENV carries bindings and secrets, so a `URL_SIGNING_SECRET` variable or secret in the runtime environment now takes effect automatically, including on Workers, where `CONFIG_ENV` was never provided. Non-string values are ignored. Values in ENV come from outside the program: validate each value your own code reads before assigning a domain type.
  
  **Behavior change:** the root barrel no longer re-exports Hono's `env` and `getRuntimeKey` adapter helpers, which were easy to confuse with `ENV`. Import them from `hono/adapter` directly if you still need them.
- bacaacd: Render a string `HttpException` identically from controller handlers, Vela middleware and
  raw Hono middleware: `{ error: { code, message } }`, with the code taken from the status
  (`not_acceptable` for 406, `bad_request` for an unmapped 4xx). Object responses still ship
  verbatim from controller handlers and Vela middleware, and from raw Hono middleware below 500.
  
  **Behavior change:** a 5xx string `HttpException` no longer sends its message to the client;
  the body carries only the status title, such as
  `{ error: { code: 'internal', message: 'Internal Server Error' } }`. Middleware exceptions
  use the canonical body instead of `{ statusCode, message }`, and an `HttpException` thrown by
  raw Hono middleware keeps its status instead of becoming a redacted 500. Its body is still
  redacted to the status title at 5xx, including an object response, such as
  `{ error: { code: 'service_unavailable', message: 'Service Unavailable' } }` for a 503.
- a814199: Add `readJsonBody(c, { maxBytes? })`, the JSON body reader used by `@Body()` and
  `defineEndpoint` `json` groups, for routes registered directly on Hono.
  
  **Behavior change:** JSON bodies must be sent as `application/json` or a `+json` media type
  such as `application/vnd.api+json` (parameters like `charset` are allowed). Any other body,
  including one with no `Content-Type`, is rejected with 415 `unsupported_media_type` instead of
  being parsed as JSON, so a cross-site `text/plain` or form-encoded POST can no longer reach a
  JSON handler without a CORS preflight. Requests without a body still resolve `@Body()` to
  `undefined`. Send `content-type: application/json` from clients and tests that post JSON.
- 1838474: **Behavior change:** `LiveModule` now fails at bootstrap when the application registers no `WsDispatcher`. Subscriptions only arrive over the `$live` WebSocket event, so without `WebSocketModule.forRoot()` (or `CloudflareWebSocketModule.forRoot()` on Cloudflare) every subscribe was dropped without an error.
- 8a3016c: **Behavior change:** `MetadataRegistry.clear()` is removed, with no alias. It had no effect: the registry holds decoration metadata only, and each application keeps its own state in its container. Delete the calls, typically `beforeEach(() => MetadataRegistry.clear())` in tests; no replacement is needed. Framework-internal suites that must wipe decoration metadata keep `MetadataRegistry.reset()`, available from `@velajs/vela/internal`.
- d803a49: Accept Nest's trailing wildcards in `forRoutes()` and `exclude()` targets. A trailing `cats/{*splat}`, like `cats/*`, matches `/cats` and every path beneath it, as in Nest. A trailing `cats/*path` matches one or more characters beneath `/cats` but not `/cats` itself, so `exclude('users/*id')` still runs the middleware on `/users`. A trailing `(.*)` reads as `{*path}` in `forRoutes()`, as Nest 11 rewrites it: `forRoutes('cats/(.*)')` also covers `/cats`, and a lone `forRoutes('(.*)')` matches every request, including `/` and the global prefix's own root. In `exclude()` it keeps the strict reading, so `exclude('cats/(.*)')` still runs the middleware on `/cats`. `'*'`, `'/*'` and `'{*splat}'` match every request.
  
  **Behavior change:** path targets accept only literal segments, `:name` segments and a trailing wildcard. Other syntax now throws at route build, naming its cause, instead of matching whatever one of Hono's routers makes of it: `{regex}` constraints such as `:id{[0-9]+}` or `:action{login|register}` (Hono's TrieRouter anchors only the first and last alternative of a top-level `|`, so the latter also matched `/auth/login-as/42`, and constraints that span segments backtracked), optional `?` segments such as `:id?`, a wildcard before the last segment such as `files/*/raw`, `*/*` or `files/*path/:id`, a `*` or `:` inside a segment such as `us*` or `abc:name`, a parameter name that is not an identifier such as `:name.pdf`, `:from-to` or `:x@1` (Hono's PatternRouter reads `:name.pdf` as `:name` followed by `.pdf`), other parentheses or braces such as `:id(\d+)` or `users{/:id}`, and empty segments such as `a//b`. Use `:name`, list each path, or target the controller.
- b235935: Fix consumer middleware that silently skipped the routes it was bound to. `forRoutes(Controller)` now asks Hono which handler serves each request and runs exactly when it is one of the controller's own handlers, whatever the route's syntax, HTTP method, global prefix or URI version. It also covers an empty-path `@Controller()`, and HEAD requests served by a GET handler. String and `{ path, method }` targets use a small grammar that Vela matches itself, segment by segment, in time linear in the request path: literal segments, `:name` segments with an identifier name that match one segment (decoded line terminators such as `%0A` included) and a trailing wildcard. Hono's routers do not all read these forms the same way: the RegExpRouter's trailing `*` stops at a decoded line terminator, the LinearRouter (used by `hono/quick`) serves `:name` on an empty segment, and the PatternRouter reads `:name.pdf` as `:name` followed by `.pdf`. `forRoutes()` targets take the broader reading and fail closed, so `:name` also matches an empty segment; `exclude()` targets take the strict one, so `:name` matches only a non-empty segment. A trailing wildcard matches decoded line terminators in both. Targets add no routes to the Hono app, so they never change which of Hono's routers the app uses, never conflict with a route such as the `RpcModule` endpoint, and leave the app mountable by a parent on any router. A `forRoutes()` target also covers the paths beneath it. When a parent app mounts the Vela app with `parent.route(base, app)`, path targets match the request path beneath that base, including trailing-slash and parameter bases such as `/m/` or `/:tenant{[a-z0-9-]+}`. Add `RouteInfo.absolute`: `{ path, method?, absolute: true }` matches the path as written, for routes served outside the global prefix such as `mountOpenApi()` documents, the `RpcModule` endpoint, Cloudflare WebSocket upgrades and routes added to the Hono app directly.
  
  **Behavior change:** String and `{ path, method }` targets in `forRoutes()` and `exclude()` now resolve under the global prefix, so write them without it or pass `absolute: true`. A target that still starts with the global prefix throws at route build instead of silently matching nothing. `exclude()` matches its patterns exactly and no longer skips the paths nested beneath them; a trailing `/` is significant. `forRoutes(Controller)` matches only requests Hono dispatches to that controller's own handlers, not every path under its prefix, so a path that another controller's route serves first no longer runs it, and it throws at startup when the controller declares no routes. A request whose method token is `ALL` now matches only targets without a method, as Hono routes it, instead of every method-scoped `forRoutes()` and `exclude()` target. `forRoutes('*')` is unchanged.
  
  **Behavior change:** under a parent app's mount base that does not spell the start of the request path, because Hono decoded a percent-encoded parameter value (`/a%3Ab`) or the request stops at `/m` under a `/m/` base, the middleware now runs and its `exclude()` path targets are ignored for that request. The same applies on every request under a base parameter whose `{regex}` constraint can match a `/`, such as `/:org{.+}` or `/:org{(?:[a-z]+/)?[a-z]+}`, where Hono can give the middleware and the route different values.
  
  **Behavior change:** a `forRoutes()` `:name` segment, including one from a global prefix such as `/:tenant`, now also matches an empty segment, so a parent app on Hono's LinearRouter or `hono/quick` that serves `/app//settings` with `/app/:org/settings` runs the middleware. `exclude()` still needs a non-empty segment.
  
  **Behavior change:** a controller route that a parent app serves without the Vela app's `'*'` middleware, as Hono's TrieRouter does under a mount base whose parameter must span a `/` (`/:org{[a-z]+/[a-z]+}`), now answers 500 with `Vela middleware chain did not run — unsupported mount`, reported like any other server error, instead of running without body limits, global middleware or consumer middleware.
- 08a81c8: Check relative `forRoutes()` and `exclude()` path targets against the routes registered at startup, so a target for a route served outside the global prefix no longer matches nothing silently. The check samples concrete paths shaped like each target and route, reading a `{regex}`-constrained route parameter as one segment, so `forRoutes('users/:id')` reaches `users/:id{[0-9a-f-]{36}}` whatever the constraint; it only reports, and never decides whether a request runs the middleware.
  
  **Behavior change:** with a global prefix, a relative target that reaches no route under the prefix but matches a route served outside it, such as `forRoutes('rpc')` for the `RpcModule` endpoint or a route contributor's path, now throws at route build and names the `{ path, absolute: true }` form to use instead.
  
  **Behavior change:** a relative `forRoutes()` target that matches no route registered at startup is reported through the container's diagnostics policy (`'log'` warns, `'throw'` fails bootstrap). Routes added to the Hono app after startup, such as `mountOpenApi()` documents, WebSocket upgrade paths and `app.getHonoApp()` routes, need `{ path, absolute: true }` with the path they are served on. The report suggests the resolved path with the global prefix kept, such as `{ path: '/api/users/:id', absolute: true }`, never one that drops it.
- 5b5b81d: **Behavior change:** the container plans each class provider's constructor once, at registration, and throws the new `MissingInjectionMetadataError` before anything constructs it when a parameter of a class with a class decorator or `@Inject`/`@Optional` entries has no usable token. That covers a constructor that declares more parameters than its `design:paramtypes` and `@Inject` indexes describe (a build without `emitDecoratorMetadata`), and a parameter whose paramtype is `Object` or `undefined` (an interface, a type-only import, or a circular import) without `@Inject(token)`. Previously the first case constructed the class with `undefined` injected fields, and the second failed only when the class was first resolved. `@Optional()` parameters still resolve to `undefined`, and `forwardRef` tokens are still evaluated at resolution. The error exposes `className`, `parameterIndex` and `reason`. For a missing `design:paramtypes` entry, the message also explains that esbuild emits no decorator metadata, so neither does a Worker that `wrangler deploy --config` bundles itself, and that the build should go through Vite (Oxc with `emitDecoratorMetadata`) or another transform that emits it.
  
  A subclass without its own constructor now inherits its parent's constructor metadata (`design:paramtypes` and `@Inject`/`@Optional` entries) instead of being constructed with no arguments. An unregistered guard, pipe, interceptor, filter or middleware class that inherits constructor dependencies this way now fails with the existing "Cannot instantiate" error instead of being constructed with `new` and no arguments.
  
  A class with no class decorator, such as a third-party client used with `useClass` or an undecorated test fake passed to `overrideProvider().useClass()`, is still constructed with no arguments. **Behavior change:** when it declares constructor parameters, which stay `undefined`, that is reported through the container's diagnostics policy with a message that names the missing class decorator; decorate it with `@Injectable()` or provide it with `useFactory`.
  
  **Behavior change:** registering a provider class that carries no class decorator, and exporting a token that is neither a local provider nor exported by an imported module, are now reported through the container's diagnostics policy: `'log'` warns (with a `[vela]` prefix), `'throw'` fails bootstrap and `'silent'` stays quiet. Both previously always called `console.warn`. `@Module` classes resolved for `configure()`, `@Catch` filters and classes with gateway or discoverable class decorators no longer trigger the missing-decorator warning.
  
  `Reflector`, `SerializerInterceptor` and `ValidationPipe` are now `@Injectable()`, so `defineProvider(APP_PIPE, { useClass: ValidationPipe })` keeps working: its optional schema parameter is `@Optional()`. An unregistered guard, pipe, interceptor, filter or middleware class whose constructor parameters are all tokenless `@Optional()` slots (an erased type with no `@Inject`, like `ValidationPipe`'s schema) is constructed with `new` and no arguments, so `@UsePipes(ValidationPipe)`, `@Body(ValidationPipe)`, `app.useGlobalPipes(ValidationPipe)` and `ValidationPipe` subclasses keep working. An unregistered class whose `@Optional()` parameters name a token (`@Optional() @Inject(TOKEN)` or a class type) is constructed through the container from the requesting module on the request path, so a registered and visible token is injected instead of skipped, and a guard that falls back when its policy is missing cannot fail open; synchronous resolution (such as `resolveScopedComponents`) throws the "Cannot instantiate" error for it. Previously any `@Optional()` parameter made such a class fail with that error.
- 7daf4fc: **Behavior change:** importing the same `(class, key)` module instance twice with different inputs is now reported through the container's diagnostics policy (`'log'` warns, `'throw'` fails bootstrap) instead of silently dropping the repeat's providers. `defineModule`, `sideEffectModule` and `defineConfigurableModule` record the inputs each definition was built from. The loader compares plain values structurally, including their symbol-keyed properties, and functions, symbols and class instances such as tokens by reference, using ids owned by that loader: source text cannot see what a closure captured, so a parameterized helper called with different arguments (`database('PRIMARY_URL')` and `database('ANALYTICS_URL')`) is reported instead of silently keeping the first configuration. A helper that rebuilds one configuration on every call is reported too; the diagnostic suggests importing one shared definition (for example, export a const of the `DynamicModule`) or giving each configuration its own `key`. The first definition still wins, and identical repeats still deduplicate without a diagnostic.
- 35e8e0d: **Behavior change:** `ModuleRef` is now scoped to the module that injects it. The container builds one per module and owner: singletons receive one owned by the application root, and request-scoped consumers receive one bound to their own request, which closes with it. `ModuleRef` is no longer registered in the root bucket, so `container.has(ModuleRef)` is `false`, and its constructor takes `(container, moduleId)`. `app.get(ModuleRef)` still returns an application-wide reference.
  
  - `get(token, { strict })` resolves with the host module's visibility (its own providers, its imports' exports and global tokens) instead of looking the token up across the application. Pass `{ strict: false }` for the application-wide lookup. `get` now throws for request-scoped and transient providers.
  - `resolve(token, context?, { strict })` now returns a `Promise`. `context` is an `ExecutionContext`, the Hono `Context` of a Vela-managed request, or an execution-scope `Container`, and request-scoped providers resolve in that scope. Without a context it resolves where the reference is owned, so a singleton's reference throws for request-scoped providers instead of caching them on the root. It never creates a request scope.
  - `create(Type)` now returns a `Promise` and injects the class's dependencies with the host module's visibility. It no longer bypasses module visibility.
  
  `Container.createDetached()` is removed. Use `moduleRef.create(Type)` or the new `Container.construct(Type, moduleId)`. Adds the `ModuleRefContext` and `ModuleRefLookupOptions` types.
- 4420501: Providers and enhancers are authored as in Nest:
  
  - `@Module({ providers })` accepts `{ provide, useValue | useClass | useExisting | useFactory }` literals, including `APP_*` tokens. Each literal in an array written in `@Module` is checked against its token, so a value, class, alias or factory result of the wrong type does not compile. A literal factory takes no parameters; a factory with dependencies keeps using `defineProvider`, which infers them from `inject`. `@Module` also accepts a `ModuleOptions` object and entries typed with the whole `Provider` or `ProviderLiteral` union, such as a `Provider[]` parameter or `dynamic.providers ?? []`, alone or spread into an array next to other entries (`[...(dynamic.providers ?? []), AuditService]`); their literals are validated when the module loads, while a literal that names its token, in an array literal or in a list declared without a type annotation, is checked against it, also next to a single spread; a literal written between two spreads (`[...shared, literal, ...extra]`) is checked only when the module loads. `DynamicModule.providers` and `defineModule` `setup` contributions accept the loosely typed `ProviderLiteral` union, and the module loader checks each literal when the module loads: an entry that is not a provider fails with an error naming the list entry and its token. Adds the `Provider`, `ProviderLiteral`, `TypedProviderLiteral`, `CheckedProviders`, `FactoryInject` and `ModuleDecoratorOptions` types.
  - A factory without parameters may omit `inject` in `defineProvider`, `lazyProvider`, literals and `forRootAsync` options. Their options intersect `FactoryInject<Inject>` with one `useFactory` type, so a factory's literal results keep their literal types; a module that wraps `forRootAsync` forwards its options object whole (`{ ...options, useFactory }`) and first calls the newly exported `assertFactoryInject(name, options.useFactory, options.inject)`, because its wrapper hides the caller's factory arity.
  - Every application provides `Reflector` globally, so guards and interceptors inject it instead of calling `new Reflector()`. A framework-global token (`Reflector`, `ENV`, `NONCE_STORE`, ...) resolves to the application's registration from every module that neither provides it, imports a module that exports it, nor sees a `@Global()` module that exports it; a module that lists one in its providers uses that local provider.
  - Any Vela class decorator implies `@Injectable()`: discoverable class decorators such as `@Processor` and `@LiveResolver`, and `@Catch`, mark the class injectable without changing a declared scope.
  - Guard, pipe, interceptor and filter classes referenced by `@UseGuards`, `@UsePipes`, `@UseInterceptors`, `@UseFilters` or parameter decorators on a module's class, class providers or controllers (gateways, processors, live resolvers and other entrypoint classes included) need no `providers` entry.
  - `exports: [ImportedModule]` re-exports everything the imported module exports.
  - Module classes are constructed through DI and receive lifecycle hooks.
  
  **Behavior change:**
  
  - Referenced enhancer classes are registered in the declaring module unless one is already visible there, and resolve through the container from that module. A singleton enhancer is now built once, at bootstrap (or with its lazy module), and receives lifecycle hooks, instead of being built with `new` on every request; a request-scoped one, declared or bubbled, is built per request. An enhancer whose dependencies the declaring module cannot see now fails bootstrap with `UnresolvedDependencyError` instead of failing each request, and one registered but not exported by another module gets its own instance instead of a `ModuleVisibilityError`. A referenced class with no class decorator of its own is registered with the dependencies it inherits from a decorated parent class; one with no constructor metadata at all is still built with `new`, once per scope. Classes passed to `app.useGlobalGuards()` and the other `useGlobal*` methods are not scanned.
  - The module class is registered in its own module and constructed at bootstrap (or with its lazy group), and, as in Nest, receives `onModuleInit`, `onApplicationBootstrap` and the shutdown hooks last within its module: after the module's providers, controllers and registered enhancers, and before the providers of the modules that import it. Lifecycle hooks now run module by module, so a module's controllers receive theirs before the providers of the modules that import it instead of after every provider, and each keyed instance of one module class (`forFeature('a')`, `forFeature('b')`) runs its own providers, controllers, enhancers and module class in turn. It now appears among its module's providers in `getModuleDescriptions()` and to `DiscoveryService`, and `app.get(ModuleClass)` returns it. A module class whose constructor dependencies are not visible now fails bootstrap.
  - `exports: [ImportedModule]` no longer reports an unknown export: it expands to the imported module's exports, and a dynamic module is re-exported by its class. Re-exporting a module whose exports a `forwardRef` import cycle leaves unknown throws; export its tokens directly.
  - A class that declares no scope takes the nearest scope a parent class declares with `@Injectable({ scope })`, whether it is a provider, a `useClass` target or an enhancer registered for a module. A subclass of a request-scoped guard, decorated or not, is built per request instead of becoming a singleton shared across requests; declare `@Injectable({ scope: Scope.DEFAULT })` on the subclass to keep one instance.
  - Explicit component lists resolved for a module, such as the operation-level guards `resolvePipelineComponents()` resolves for a GraphQL resolver, use a registration only when that module can see it; a class another module keeps private is built as an unregistered class instead of failing with `ModuleVisibilityError`. A class passed to `app.useGlobalGuards()` and the other `useGlobal*` methods resolves from the first module that registers it and is not a lazy module still pending, so a global component no longer materializes a lazy module another module can serve; when every module that registers it is pending, a lazy module that lists the class in its providers serves it, materialized with its group, and one that holds only the copy registered for an enhancer its classes reference never does.
  - Modules look tokens up in Nest's order: their own providers, then what their imports export (following re-exports), then what the one `@Global()` module that exports the token provides, then the application's registration of a framework-global token, whether the application configured it or the framework registers it by default, or an `InjectionToken` default. A token that a module's imports export now resolves to that export, instead of failing with `MultipleProvidersFoundError` because a `@Global()` module exports it too or another module registers a copy, and, for an `InjectionToken` with a default factory, instead of resolving to the default. An `InjectionToken` default factory applies only when no module registers the token: a module that cannot see another module's registration of it fails with `ModuleVisibilityError`. A `@Global()` module that exports a framework-global token such as `NONCE_STORE` or `Reflector` overrides the application's registration in every module that neither provides the token nor imports an exporter of it, and a copy another module registers without exporting it is no longer a candidate. `resolveAll(token, moduleId)` returns the providers of the step that `resolve(token, moduleId)` takes its provider from, following re-exports, instead of combining the module's own provider, every registration of a global token and its direct imports' exports. Two `@Global()` modules that export one token still fail with `MultipleProvidersFoundError`, and so does a module whose imports export the token from two modules, including a `@Global()` module that it also imports explicitly.
  - An application-wide lookup, which has no requesting module (`app.get(token)`, `ModuleRef.get(token, { strict: false })` and the dependencies of the providers the application registers itself, such as `SignedInvocationGuard`, `SignedUrlGuard`, `UrlGeneratorService` and `InternalDispatcher`), ranks the application's registrations by who made them. What the application configures itself still answers first: the `env` option, a runtime adapter's `configureContainer`, `app.useGlobalExceptionHandler()`, a `@velajs/testing` override, or any other root registration made after bootstrap registered its defaults. Then the one `@Global()` module that exports the token answers, then the framework default that bootstrap registers, such as the `MemoryNonceStore` behind `NONCE_STORE` or `Reflector`, then the first module that registers the token. A `@Global()` module that provides a durable `NONCE_STORE` therefore now protects signed invocations against replay, instead of losing to the framework's `MemoryNonceStore`, while a handler passed to `app.useGlobalExceptionHandler()` still reports instead of the one a global `ErrorsModule.forRoot({ handler, isGlobal: true })` exports. Two `@Global()` modules that export a token the application did not configure itself now fail with `MultipleProvidersFoundError` there too, instead of resolving to the framework default or to the first of them. The new `Container.markRootDefaults()`, which `bootstrap()` calls before it registers the `env` option and runs the adapters' `configureContainer`, ranks the root registrations made so far as framework defaults.
  - A factory that declares parameters but has no `inject` now throws when it is defined, naming its token, instead of running with `undefined` arguments.
  - `DynamicModule.providers` and `ModuleContributions.providers` are typed `Provider[]`, and `ModuleOptions.providers` and `ModuleMetadata.providers` are `readonly Provider[]`: their entries may be literals, which `Container.register()` does not accept; register a `DynamicModule` through a module import instead. `AsyncModuleOptions` and `LazyProviderSpec` are now type aliases instead of interfaces, so an interface can no longer extend them: intersect instead (`AsyncModuleOptions<T, Inject> & { name: string }`).
  - `CacheInterceptor`, `ResponseCacheInterceptor` and `ThrottlerGuard` take the injected `Reflector` as their last constructor parameter; a subclass that declares its own constructor passes it to `super()`.
  - `isInjectable()` returns `true` for classes decorated with a discoverable class decorator or `@Catch`.
- 6d4f0c0: **Behavior change:** `@Optional()` now decides by module visibility. It still injects `undefined` when no module registers the token. When another module registers the token without exporting it to the consumer, the mistake is reported through the container's `diagnostics` policy: `throw` fails construction with `ModuleVisibilityError`, `log` warns once per consuming module and injects `undefined`, and `silent` injects `undefined`. Previously such a dependency threw `ModuleVisibilityError` in every mode. An `@Optional()` `InjectionToken` with a default `factory` now receives the factory's value instead of `undefined`.
- e3bda2a: Module-level `@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters` and `@UseMiddleware` now run once per request when the same module classes are bootstrapped more than once in an isolate (per-environment rebuilds, Durable Object instances, tests). Previously every bootstrap added another copy to the module's controllers, so later applications wrapped responses twice and ran guards such as throttling twice.
  
  **Behavior change:** module-level components are resolved per application from the module instance that declares the controller instead of being copied onto the controller's metadata. `MetadataRegistry.propagateControllerComponents()` is removed, and `MetadataRegistry.getController()` returns only a class's own decorations. The static `ComponentManager.getScopedComponents(type, controller, handlerName)` from `@velajs/vela/internal` is removed; use the new `getScopedComponents(type, class, method, container, moduleId)` from `@velajs/vela` instead, which reads the declared entries, module-level ones included, without constructing them; `resolveScopedComponents()` and `resolveScopedComponentsAsync()` include them for the owning `moduleId` (or the class's only owner when it is omitted). The `@velajs/authz` authorization audit and `@velajs/mail` inbound dispatch recognize module-level components the same way.
- bd7e3c9: Add Nest-style queue registration to `@velajs/vela/queue`. `QueueModule.forRoot({ driver, dispatch })` configures the application's driver once and is global; `QueueModule.registerQueue({ name, binding?, consumer? })` registers a queue in the module that uses it and provides its `QueueClient`, which `@InjectQueue(name)` injects (the same as `@Inject(queueToken(name))`). `registerQueue` accepts several queues in one call, and declares no class for them, so calling it again, for example each time an application is rebuilt, does not grow the isolate's decorator metadata. Registering one queue in several modules is fine: registrations are merged by name, their `consumer` pins accumulate, and two different bindings for the same name fail bootstrap. `QueueRegistry` (exported by the module) lists the merged registrations, and each registered queue is published as a portable `queue:registration` entrypoint (`{ name, binding?, consumers }`) for deployment checks.
  
  Add `QueueClient.addBulk(jobs)`, which validates every typed job before any is sent, then hands the whole batch to the new optional `QueueDriver.enqueueBatch(requests)`, or enqueues one job at a time when the driver has none. It resolves only when every job was accepted; otherwise it rejects with a `QueueBatchError` whose `accepted` and `rejected` list the job ids. Each entry (`QueueBulkEntry`) has the `{ job, data, options }` shape of an `add(job, data, options)` call, not BullMQ's `{ name, data, opts }`; an entry with any other key, such as `opts`, does not compile. Each entry is typed on its own, so named entries with different payloads and typed and named entries can share one call.
  
  Each failure of a native batch delivered through `QueueModule`'s consumer is reported once on the `queue` edge: processor failures where the processor ran, and a message that is not a job, an unregistered or mis-pinned queue, a job no processor handles or a rejected signed re-entry when the batch settles.
  
  A driver factory (`driver: (context) => QueueDriver`) now receives a `QueueDriverContext`: the application's `ENV`, when a runtime seeded one, and its `QueueRegistry`. A factory still builds a fresh driver for each application.
  
  **Behavior change:** `QueueModuleOptions.queues` is removed, from `forRoot` and `forRootAsync` alike. Replace `QueueModule.forRoot({ queues: ['email'], driver })` with `QueueModule.forRoot({ driver })` plus `QueueModule.registerQueue({ name: 'email' })` in the module that produces or processes the queue. `forRoot()` takes no required options, is global, and is imported once per application: two different `forRoot` configurations now fail bootstrap. The driver and a signed `dispatch` policy compare by reference, so a different driver instance or another signed policy object conflicts, even one that differs only in its target, method or TTL, or one a helper builds from the same source with another captured target; importing the same objects again deduplicates. `forRootAsync` is keyed by its options object, with or without an explicit `key`: importing the same object again deduplicates, and a different one, including one that shares its `key`, or a `forRoot` next to it, fails bootstrap. `dispatch` may now come from a `forRootAsync` factory.
  
  **Behavior change:** `QueueDispatchBinding.dispatch(job, options?)`, the entry point for platform deliveries, rejects a job whose queue is not registered in the application and, unless `options.unhandled` is `'ignore'`, a job no processor handles (options that omit `unhandled`, such as `{}`, keep that default), so the platform retries it instead of acknowledging it, and resolves with a `QueueDispatchResult` (`handled` is 1 for a signed re-entry). The binding's constructor takes the application's `QueueRegistry` instead of a list of queue names.
  
  **Behavior change:** `dispatchQueueJob(container, entrypoints, job, options?)` honors the application's `QueueModule` dispatch policy. When the application imports `QueueModule.forRoot()`, it delivers through `QueueDispatchBinding` like a native delivery: the job's queue must be registered, and signed dispatch re-enters the signed route, so a custom transport can no longer bypass the route's global guards. Without a `QueueModule` it still calls the processors directly. `dispatchQueueJob` is for tests and for transports other than Cloudflare Queues, which `cloudflareQueues()` delivers itself; a raw `@QueueConsumer` must not carry jobs of registered queues, so do not bridge one to processors with it.
  
  **Behavior change:** `dispatchQueueJob` rejects a job no processor handles, such as a misspelled or removed job name, instead of resolving with `handled: 0`: `options.unhandled` now defaults to `'error'`, as for a native delivery, so a custom transport that acknowledges a message when delivery resolves never loses one. A transport acknowledges a message only when `dispatchQueueJob` resolves and lets it be retried when it rejects. Pass `{ unhandled: 'ignore' }` to keep resolving with `handled: 0`.
  
  **Behavior change:** `QueueDriverEntrypoint` no longer has a `queue` field; a driver's platform routes carry only `kind` and `meta`.
  
  **Behavior change:** a processor failure is reported once, where the processor ran, on every delivery path. A detached inline delivery (`inline()` in `immediate` mode) no longer reports it a second time with `note: 'inline driver'`; that note is kept for failures no processor reported. A processor that throws a value that is not an object (`throw 'boom'`) is reported with that value and then rethrown as an `Error` whose `cause` is the value, so a transport that settles several deliveries recognizes it as already reported.
- 2b74880: Remove `ZodValidationPipe`. It called `schema.parse()` directly, so invalid input
  escaped as a raw validator error and was answered with a 500 instead of a 400.
  
  **Behavior change:** `ZodValidationPipe` is no longer exported. Replace
  `new ZodValidationPipe(schema)` with `new ValidationPipe(schema)`, which accepts a Zod or
  other Standard Schema, a `parse()` parser, or a `defineDto` descriptor. Invalid input now
  receives a 400 whose body carries `message: 'Validation failed'` and the normalized
  `errors`; an exception thrown by a validator itself is still a server error.
- 5ba8635: **Behavior change:** `REQUEST_CONTEXT.id` mirrors an inbound `x-request-id` header only when
  it is 1–128 characters of `A-Z`, `a-z`, `0-9`, `.`, `_`, `:` or `-`. Any other value is
  replaced by a generated UUID, so caller-supplied text cannot inject markup, quotes or
  oversized values into logs and correlation fields.
- db0c834: **Behavior change:** Resolving a request-scoped provider on the root container now throws instead of constructing it there and caching it for the life of the application. This covers providers declared with `Scope.REQUEST` and providers that are request-scoped because they depend on one, through `container.resolve()`, `container.resolveAsync()` and therefore `app.get()`. Resolve them in the execution scope of the invocation: `getRequestContainer(c)`, `context.getContainer()` or the `runInEntrypointScope()` callback argument. Application-level error reporting on the root container falls back to the default report when the registered exception handler is request-scoped.
  
  **Behavior change:** `DiscoveryFilter.includeRequestScoped` is removed. Pass `requestScope`, an execution-scope container of the same application, to resolve request-scoped discovery hits inside that invocation. Without it they are still returned with `instance: undefined`.
  
  Add `InjectionTokenOptions.scope`. `new InjectionToken(name, { scope: Scope.REQUEST, factory })` declares a per-scope value that a runtime seeds with `setRequestInstance()`: its consumers are request-scoped in every container, even before the token is first resolved, and `factory` runs only in a scope that nothing seeded, so it can throw to say where the token resolves. A token default without `scope` is still a singleton.
  
  Adds `Container.getResolvedScope(token, moduleId?)`, the effective scope of what a resolution would return without constructing it, and `Container.sharesRootWith(other)`.
- d6f6a65: Global middleware reads a `static priority` from the `useClass` or `useExisting` target of an `APP_MIDDLEWARE` provider without constructing it, so a request-scoped middleware is ordered by its static priority instead of silently sorting at 0.
  
  **Behavior change:** a request-scoped global middleware that declares no `static priority` is reported through the container's diagnostics policy (`'log'` warns, `'throw'` fails bootstrap), because its position cannot be read at route build and it sorts at priority 0. Declare `static priority` on its class. A singleton `APP_MIDDLEWARE` whose class declares a static priority is no longer constructed at route build to read it.
- 8a3016c: `VelaFactory.create`, `bootstrap` and `ModuleLoader.load` accept a `DynamicModule` root as well as a module class, so a configurable root such as `AppModule.forRoot(...)` needs no wrapper class. `createOpenApiDocument` documents a `DynamicModule` root too.
  
  `bootstrap` registers the root, exactly as passed, as the new global `ROOT_MODULE` token next to `Container`, so any module can read the application's graph (for example to document it) without importing the root back.
  
  `countRegisteredClasses()` in `@velajs/vela/internal` reports how many classes the isolate-global metadata registry holds, for tests that prove a bootstrap path declares nothing new.
- d5a3ec8: Add `invokeScheduledJob(container, entry, invocation, options?)`, the one dispatch primitive for scheduled jobs. The Node executor, the Cloudflare adapter's cron triggers and Studio's run-now all use it: the job is resolved by its owning module in a fresh invocation scope, receives only its invocation, honors `ScheduleModule.forRoot({ dispatch: { kind: 'signed' } })` through `InternalDispatcher` (the signed route runs its global guards), and a failure is reported once on the `schedule` edge and rethrown. `options.seed(scope)` lets a runtime seed request-scoped values, such as a native event token, into the job's scope. A custom runtime that fires scheduled jobs should call it.
  
  Add the optional `SCHEDULE_INVOCATION_SEED` token (`ScheduleInvocationSeed`): a runtime adapter provides it so a job fired outside its native trigger, such as Studio's run-now, gets what the trigger would have seeded into its scope. Callers pass it to `invokeScheduledJob` as `seed`.
  
  Add `CronInvocation`, `IntervalInvocation` and `ScheduleDecorator`. `@Cron` and `@Interval` are now typed method decorators: the decorated method may declare no parameter or one that accepts its invocation.
  
  Add `scheduledJobComponents(container, entry)`, which names the `@UseGuards`, `@UseInterceptors` and `@UseFilters` declarations that apply to a scheduled job and that direct dispatch never runs. `invokeScheduledJob`, `cronDialectAmbiguity`, `scheduledJobComponents` and `SCHEDULE_INVOCATION_SEED` are exported from the root `@velajs/vela` barrel; there is no `@velajs/vela/schedule` subpath yet.
  
  Add `DiscoveryFilter.deferRequestScoped`, which returns request-scoped providers as metadata-only entries without the "request-scoped ... skipped" warning. `EntrypointRegistry.build` uses it, so an application whose `@Cron` job, `@Processor` or other entrypoint class is request-scoped (for example a job that injects `CLOUDFLARE_SCHEDULED_EVENT`) no longer logs that warning at every bootstrap; dispatchers already resolve such classes per invocation.
  
  Add `cronDialectAmbiguity(meta)`, which explains why a `@Cron` expression without a `dialect` fires on different days under Vela's unix dialect and Cloudflare semantics (a numeric weekday field, or both day fields restricted: Vela's unix dialect requires both to match, while Cloudflare, like standard crontab, fires when either does), or returns `undefined`.
  
  **Behavior change:** `ScheduleNodeModule` reports such an ambiguous `@Cron` declaration at bootstrap through the diagnostics policy: it warns once in the default `'log'` mode and fails bootstrap in `'throw'` mode. Declare `{ dialect: 'cloudflare' }` for a job that also runs on Workers and write its expression for Cloudflare, or `{ dialect: 'unix' }` only for a Node-only job.
  
  **Behavior change:** direct scheduled jobs run no guards, interceptors or filters on any runtime, neither app-global nor declared on the class, method or module, as with NestJS `@Cron`. Use signed dispatch to run a job through a route's request pipeline.
  
  **Behavior change:** a directly dispatched job that declares `@UseGuards` on its class, method or module fails closed instead of running unguarded: `invokeScheduledJob` refuses it before resolving it, on Node timers, Workers cron triggers and Studio's run-now alike, rethrows the refusal and reports it through the exception reporter on the `schedule` edge: guards do not run for directly dispatched scheduled jobs — use `ScheduleModule.forRoot({ dispatch: { kind: 'signed', ... } })` or remove the guard. Signed dispatch is not refused. Declared interceptors and filters remain a bootstrap diagnostic, whose message now says that a guarded job refuses to run.
  
  **Behavior change:** a scheduled job failure is reported with `source: 'Class.method'` (for example `'Reports.nightly'`) on every runtime; the Node executor previously reported only the method name.
  
  **Behavior change:** a handler decorated with `@Cron` or `@Interval` that declares another required parameter, or whose first parameter does not accept its invocation, no longer compiles. Remove the native `(controller, env, ctx)` parameters and annotate the job's parameter as `CronInvocation` or `IntervalInvocation`. `applyDecorators` accepts these typed decorators, and `@Process(definition)`, next to any other decorator, so `applyDecorators(Cron(expression, options), SetMetadata(key, value))` composes. As in NestJS, `applyDecorators` does not check the signature of the handler it decorates: only a `@Cron`, `@Interval` or `@Process(definition)` applied directly does. A variable annotated as `MethodDecorator` can no longer hold `Cron(...)` or `Interval(...)`: annotate it as `ScheduleDecorator<CronInvocation>` (or `ScheduleDecorator<IntervalInvocation>`), or let TypeScript infer it.
  
  **Behavior change:** `ScheduleNodeModule` reports, through the diagnostics policy, a `@Cron` with neither `dialect` nor `timeZone` when the process time zone is not UTC (it runs at local time under Node but in UTC on Workers), and a scheduled job that declares `@UseGuards`, `@UseInterceptors` or `@UseFilters`, which direct dispatch never runs. The default `'log'` mode warns once per declaration; `'throw'` fails bootstrap. Declare `{ timeZone: 'UTC' }`, `{ dialect: 'cloudflare' }` or `{ timeZone: 'local' }`, and move pipeline components to a signed route.
  
  **Behavior change:** importing `ScheduleModule.forRoot({ dispatch })` with two different dispatch policies in one application fails bootstrap instead of leaving the policy a job uses ambiguous or silently keeping the first: a signed policy compares by reference, so a different kind or another signed policy object conflicts, even one that differs only in `target`, `method` or `ttlSeconds`, or one a helper builds from the same source with another captured target. Importing the same policy object again still deduplicates. Import it once, in the root module.
- 0f7e8e7: Accept a schema wherever `@Body`, `@Query`, `@Param`, `@Headers` and `@Cookie` accept a
  pipe: `@Body(schema)`, `@Query(schema)`, `@Query('page', schema)`, `@Param('id', schema)`,
  `@Headers('x-tenant', schema)` and `@Cookie('theme', schema)`. The schema can be a Zod or
  other Standard Schema, a `parse()` parser, or a `defineDto` descriptor. The decorator
  validates the value with `new ValidationPipe(schema)`, so invalid input is a 400 with the
  normalized issues, OpenAPI documents the schema, and pipes written after it receive the
  parsed output. The new `SchemaParamDecorator` type describes these overloads.
  
  **Behavior change:** a Zod schema passed to a parameter decorator used to be run as a pipe
  through its own `transform()` method, so the handler silently received a new schema object
  instead of validated data. It now validates the value and rejects invalid input with a 400.
  A Standard Schema or parser object without `transform()` used to fail with a 500 and is now
  accepted. Pipe classes and objects with a `transform()` method are still run as pipes.
- 41ec70d: Name the default provider lifetime `Scope.DEFAULT`, as Nest does.
  
  **Behavior change:** Scope.SINGLETON is renamed Scope.DEFAULT (Nest naming); no alias. Replace every `Scope.SINGLETON` with `Scope.DEFAULT`. The member's runtime value changes from `'singleton'` to `'default'`, so `getScope`, `Container.getProviderScope`, `Container.getResolvedScope`, `DiscoveryService` registrations and the conflicting-scope decorator error now report `default`. Code that compares a scope against the string `'singleton'` must compare against `Scope.DEFAULT` instead.
  
  **Behavior change:** Studio's `app.modules` provider scopes and `app.entrypoints` scopes label that lifetime `default` instead of `singleton`. `StudioProviderScope` is now `'default' | 'transient' | 'request'`, and the response validators reject `singleton`. Because an op's payload changed, `STUDIO_PROTOCOL_VERSION` is now 3 and `StudioConnection.protocolVersion` is typed as that constant. The Studio UI rejects a health probe or host connection that reports another version with its protocol-mismatch error instead of failing on the first scope label, so upgrade `@velajs/vela`, `@velajs/studio`, `@velajs/studio-ui` and `@velajs/studio-host` together.
- b265297: **Behavior change:** an `undefined` or `null` entry in a module's `imports`, `providers`, `controllers` or `exports` now fails the load with the new `UndefinedModuleError`, for example `AppModule.imports[2] is undefined — usually a circular file import; use forwardRef(() => X)`. The error exposes `moduleName`, `property` and `index`. Previously the loader failed with an unrelated `TypeError`, and `createOpenApiDocument` silently skipped the entry.
- bdfff47: **Behavior change:** a class constructor argument without a provider visible to the resolving module now fails with the new `UnresolvedDependencyError`, which names the class, its module, the argument and the fix, for example `Cannot resolve UsersController(?, AuditService) in UsersModule. Argument #0 UsersService is declared in DataModule but not exported (add it to DataModule.exports)`. The other reasons read `is exported by DataModule, which UsersModule does not import (add DataModule to UsersModule.imports)` and `is not provided in UsersModule or its imports`. Previously the same failure threw a `ModuleVisibilityError` or a plain "No provider found" error that named only the token. The original lookup error stays available as `cause`, and the error exposes `className`, `moduleId`, `parameters`, `parameterIndex`, `token` and `reason` (`not-exported`, `not-imported` or `not-provided`, with the module instance ids involved).
  
  Only the innermost constructor reports: an error raised while building one of the argument's own dependencies passes through unchanged. It covers bootstrap, request-time resolution and `ModuleRef.create()`. Direct `container.resolve(token)` calls, provider factory `inject` lists, `useExisting` aliases, `forwardRef` proxies and hidden `@Optional()` dependencies keep their existing errors. Code that caught `ModuleVisibilityError` around a class resolution should catch `UnresolvedDependencyError` and read `cause`.
- 28c7d07: **Behavior change:** A `useClass` provider now keeps the scope its class declares with `@Injectable({ scope })` unless the provider sets `scope` itself. Request-scoped classes registered through `defineProvider(token, { useClass })`, an `APP_*` `{ useClass }` provider, `ErrorsModule.forRoot({ handler })` or `app.useGlobalExceptionHandler(Class)` now get a fresh instance per request instead of one singleton shared across requests. Set `scope` on the provider to choose a different lifetime explicitly.
- 8a3016c: WebSocket gateways authenticate upgrades through dependency injection. `@WebSocketGateway({ authenticator })` names a class implementing the new `UpgradeAuthenticator` interface (`authenticate(request, context)` returns a `WebSocketUpgradeIdentity` or `false`). Each application resolves it once from the module that declares the gateway, reusing a provider that module can see or constructing the class with what that module can inject (also when another module registers it without exporting it), and serves every later upgrade with the same instance. A gateway without an authenticator still refuses every upgrade, and an authenticator that throws or returns an invalid identity refuses the upgrade. Because that one instance is built once per application, an authenticator must not be request-scoped: one that declares `Scope.REQUEST` or injects a request-scoped provider, registered or not, is a configuration error. An authenticator the declaring module cannot construct, or a request-scoped one, fails the upgrade as a server error instead of admitting it.
  
  `allowedOrigins` also accepts `(env) => origins`, read from the application's `ENV` once per application. `'*'` remains a static opt-out.
  
  Transports bind a gateway to one application with `createWebSocketUpgradeGate(container, { options, moduleId })`, which runs the credential-parameter checks, the ticket extraction, Origin and `authorizeUpgrade`, and then the authenticator.
  
  **Behavior change:** the `authenticateUpgrade` closure option of `@WebSocketGateway` is removed, with no alias. Move its body into a class, `class SessionAuthenticator implements UpgradeAuthenticator { authenticate(request, context) { ... } }`, and pass `authenticator: SessionAuthenticator`; inject what the closure captured. The `authenticateWebSocketUpgrade(options, request, room)` and `authorizeWebSocketUpgrade(options, request)` helpers are removed from `@velajs/vela/websocket`; use `createWebSocketUpgradeGate(container, gateway)` and call the returned gate with `(request, room)`.

### Patch Changes

- ff44b6a: Resolve a handler's success status in one place for responses, OpenAPI documents and
  `@CacheResponse`: an `@Endpoint` contract's status, then `@HttpCode`, otherwise 200 (204
  for an empty result). OpenAPI documents that status as before, so a 2xx documented only
  with `@ApiResponse` is listed beside the default 200 the handler still sends. Statuses are
  unchanged.
- 44efdde: `Reflector.createDecorator()` no longer generates random values when no `key` is given, so a Worker that declares typed decorators at module scope starts instead of failing with workerd's "Disallowed operation called within global scope" error. Default keys stay unique within the process, including across duplicated package copies and hot-reloaded modules.
- Updated dependencies [bacaacd]
  - @velajs/errors@1.23.0

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

## 2.0.0

### Major Changes

- b99d71a: Compose native Worker applications through modules. QueueModule now initializes transport configuration at bootstrap and publishes driver-owned native routes, removing application-written consumer bridges. Duplicate queue ownership fails at startup. Cloudflare rejects deliveries without a consumer instead of silently accepting them; existing native decorators and envelopes remain supported.
  
  Cloudflare roots accept dynamic modules and asynchronous factories. RPC server modules and injectable named clients reuse the existing schema-validated dispatcher. Deployment checks validate module queue mappings, producer declarations and RPC service bindings. A four-worker example and exact-archive runtime proof cover composition, native delivery and scheduling.

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
