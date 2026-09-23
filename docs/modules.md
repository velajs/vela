# Authoring Vela Modules

The contract for building a Vela feature module — first-party or third-party.
Everything here is public API from `@velajs/vela`; a module never needs
`@velajs/vela/internal`.

## Configurable modules with `defineModule`

`defineModule` generates `forRoot` and `forRootAsync`, derives an instance key,
and registers providers from the module's options. Use `defineProvider` to check
each provider against its token and infer factory dependencies:

```ts
import { defineModule, defineProvider, InjectionToken, stableHash } from '@velajs/vela';

export interface StorageDriver {
  read(key: string): Promise<string | undefined>;
}

export interface StorageOptions {
  name: string;
  driver: () => StorageDriver;
}

export const STORAGE_OPTIONS = new InjectionToken<StorageOptions>('STORAGE_OPTIONS');
export const DRIVER = new InjectionToken<StorageDriver>('STORAGE_DRIVER');

const { ConfigurableModuleClass } = defineModule<StorageOptions>({
  name: 'Storage',
  optionsToken: STORAGE_OPTIONS,
  key: (options) => stableHash({ name: options.name }),
  setup: ({ OPTIONS }) => ({
    providers: [defineProvider(DRIVER, {
      inject: [OPTIONS],
      useFactory: (options) => options.driver(),
    })],
    exports: [DRIVER],
  }),
});

export class StorageModule extends ConfigurableModuleClass {}
```

Consumers import `StorageModule.forRoot({ name, driver })` into their application
module. A factory with parameters declares `inject`; a factory without parameters
may omit it. For `forRootAsync`, read resolved options through the `OPTIONS` token:
the `setup` callback only sees structural options supplied at the call site.

`setup` may also return Nest provider literals such as
`{ provide: LABEL, useValue: options.label }`, and so may a hand-written
`DynamicModule` (`providers` in what `forRoot()` returns) or a `Provider[]` list
handed to `@Module`. These literals are validated at runtime only: nothing ties
their value to their token at compile time, so the loader checks each literal's
shape when the module loads and a value of the wrong type is not caught (see
[providers](dependency-injection.md#providers)). Use `defineProvider` for any
provider whose value type matters; it is checked against its token wherever it
is listed.

- `forRootAsync({ inject, useFactory })` comes free, with typed factory
  params inferred from the `inject` tuple. Structural fields passed alongside
  the factory merge **under** the resolved options (factory wins). Their types
  come from `Partial<Options>`; DI wiring keys are reserved. The factory must
  still return the complete required options. `lazy?: boolean` is accepted
  by both registration methods, alongside the explicit `key`.
- A module that wraps the generated `forRootAsync` in its own static method
  types its options as `{ useFactory: (...deps: InferTokens<Inject>) => Result }
  & FactoryInject<Inject>`, so a factory without parameters may omit `inject`,
  and forwards the caller's object whole, replacing only what it wraps:
  `ConfigurableModuleClass.forRootAsync<Inject>({ ...options, useFactory: async
  (...deps: InferTokens<Inject>) => check(await options.useFactory(...deps)) })`.
  Destructuring `inject` out of the options separates it from `useFactory`, and
  the forwarded pair no longer type-checks.
- `ConfigurableModuleBuilder` (NestJS parity) is a thin adapter over
  `defineModule` — same engine, either entry.
- `defineConfigurableModule` remains the low-level engine for
  runtime-generated module classes. Workers bindings come from the framework
  `ENV` (`inject: [ENV]` in `forRootAsync`); see the
  [Cloudflare integration](../packages/cloudflare/README.md).

### Keys (multi-instance dedup)

`DynamicModule.key` decides instance identity: same `(class, key)` dedups
(while the constructor identity is retained), different keys coexist. A display
name is not identity: distinct classes with the same name remain independent.
The loader and OpenAPI metadata walker use the same class/key distinction.
An HTTP controller class can be mounted by only one module owner: registering
its identical routes through two owners now fails with a clear diagnostic.
Use distinct controller classes when keyed instances need separate HTTP routes.
A class registered only as another module's provider does not change the actual
HTTP owner. Middleware configured through `configure()` also retains its owner.

Rules:

1. Default `stableHash(options)` is right for value-shaped options.
2. Options carrying **stateful instances** (drivers, registries, sockets)
   must use `key: (o) => ...` over the stable identifying subset — never a
   counter (non-deterministic keys break HMR dedup), and never rely on
   `stableHash` of closures (identical source hashes collide).
3. Always honor the caller's explicit `key` (`defineModule` does).

A repeated `(class, key)` keeps only its first definition. `defineModule`,
`sideEffectModule` and `defineConfigurableModule` record the inputs each
definition was built from, and the loader compares a repeat against the first:
plain values compare structurally, while functions and class instances (such
as an `InjectionToken`) compare by reference. Source text cannot see what a
closure captured, so two closures with the same source are different inputs: a
helper such as `database('PRIMARY_URL')` and `database('ANALYTICS_URL')` that
builds a `forRootAsync` config from its argument is reported instead of
silently keeping the first configuration. A repeat built from different inputs
is reported through the container's diagnostics policy (`'log'` warns,
`'throw'` fails bootstrap) instead of silently dropping its providers. A helper
that rebuilds the same configuration on every call is reported as well; import
one shared definition (export a const of the `DynamicModule`), or give each
configuration its own `key`. Identical repeats still deduplicate. The reference
ids belong to one module loader and are released with it.

An `undefined` or `null` entry in a module's `imports`, `providers`,
`controllers` or `exports` fails the load with `UndefinedModuleError`, naming
the list and index (for example `AppModule.imports[2]`). The usual cause is a
circular file import; use `forwardRef(() => OtherModule)` for imports.

### Re-exporting modules

`exports: [ImportedModule]` re-exports everything that imported module exports,
as in Nest. Importers of the re-exporting module see those tokens, and a global
re-exporting module makes them global. A dynamic module is re-exported by its
class (`exports: [ConfigModule]`), which covers every imported instance of that
class. A module whose exports a `forwardRef` import cycle leaves unknown cannot
be re-exported: the load fails and names both modules, so export the tokens
directly instead. Exporting a module class that is not imported is reported
through the container's diagnostics policy, like any unknown export.

### Module classes

The module class itself is constructed through DI and, as in Nest, receives its
lifecycle hooks (`onModuleInit`, `onApplicationBootstrap`, the shutdown hooks)
last within its module: after the module's providers, controllers and the
enhancers registered for it, and before the providers of the modules that
import it. Its constructor can inject anything the module can see, and
`configure()` runs on the same instance.

### Tokens

Mint with `moduleToken<T>('pkg:area:thing')` (an `InjectionToken`) — never
raw strings. Pass existing tokens via `optionsToken` when migrating so
downstream `@Inject(...)` keeps working.

### Companion primitives

- `lazyProvider({ provide, inject, useFactory, memoize? })` — provides a
  memoized thunk `() => T` whose factory runs on first use; `inject` may be
  omitted when the factory takes no parameters. Workers bindings are
  available before provider initialization; lazy construction does not create an I/O context.
- `provideGlobal(kind, component)` — spread into `providers:` to register an
  app-wide guard/pipe/interceptor/filter/middleware outside `defineModule`.
- `sideEffectModule(OwnerClass, contributions)` — a contribution-only dynamic
  module. Declare the owner class once in the library; repeated calls with the
  same owner and content-derived key deduplicate. Different keys coexist.
  The legacy `sideEffectModule(name, contributions)` form creates a fresh,
  isolated class each call, even when names and keys match. It does not deduplicate.

```ts
class MessageContributions {}
export function registerMessages(messages: string[]) {
  return sideEffectModule(MessageContributions, {
    providers: [{ provide: MESSAGES, useValue: messages }],
    exports: [MESSAGES],
  });
}
```

### Optional integration contributions

Keep deployment choices in the integration's own options. For example, an
optional HTTP layer can compute `controllers` and companion `imports` in
`setup` only when `options.http === true`. Pass this structural flag directly
alongside `forRootAsync`'s factory, because resolved options arrive after graph
construction. Runtime providers should inject `OPTIONS` for the resolved bag.
This controls registration; excluding code from a bundle requires separate
imports/entrypoints. There is no global mutable module configuration.

### Global component aliases

An `APP_*` provider declared with `useExisting` remains an alias to the target
in its declaring module. The target can stay private, and keyed modules can
each alias their own registration of the same guard or middleware class.
Provider snapshots retain `kind: 'existing'` and `useExisting`, so metadata
audits can follow the alias without constructing request-scoped components.

Aliases follow the target lifetime: singleton identity and request reuse are
preserved; a transient target is resolved freshly on each use and disposed by
the container that owns that resolution. Earlier synthetic `APP_*` factory
wrappers could accidentally cache a transient target. Applications relying on
that sharing should register the target as a singleton explicitly.

Global middleware (`APP_MIDDLEWARE` and `app.useGlobalMiddleware()`) runs in
ascending `priority` order, registration order breaking ties; the default is 0.
Route build reads a `static priority` from the middleware class, including the
`useClass` or `useExisting` target of an `APP_MIDDLEWARE` provider, without
constructing it. Only a singleton without a static priority is constructed to
read an instance `priority`. A request-scoped middleware cannot be constructed
at route build, so give it a `static priority`: without one it sorts at 0, and
the container's diagnostics policy reports it (`'log'` warns, `'throw'` fails
bootstrap).

## Static roots: runtime values through DI

An application root is a module class, or a `DynamicModule` such as
`AppModule.forRoot(...)`, declared once at module scope. `VelaFactory.create`,
`createOpenApiDocument` and the Cloudflare factories (`createCloudflareWorker`,
`createCloudflareApp`, `VelaWebSocketDurableObject`) accept either. Declare
decorated classes at module scope only: a function that declares controllers,
providers or modules creates new classes on every call, and the isolate-global
metadata registry keeps every one of them.

Runtime values reach a static graph through dependency injection:

- Bindings, variables and secrets come from `ENV` in `forRootAsync({ inject: [ENV],
  useFactory })` factories, `useFactory` providers and `@InjectEnv()` constructors.
- Where a decorator needs runtime behavior, it names an injectable class instead
  of taking a closure. `@WebSocketGateway({ authenticator })` is an example, and
  its `allowedOrigins` accepts `(env) => origins`.

Each application runs these factories, so applications built from different
environments share classes but no instances. Any module can inject the root,
exactly as it was passed, through the global `ROOT_MODULE` token. Studio uses it
to document the application, for example, so no module imports the root back.

## Discovery: finding decorated providers

Never hand-roll a `container.getTokens()` scan. Declare a decorator, then ask
`DiscoveryService`:

```ts
export const QueueConsumer = createDiscoverableDecorator<{ queue: string }>('pkg:queue:consumer');
// stackable method decorators: createDiscoverableDecorator(key, { append: true })
// As a class decorator, @QueueConsumer({ queue }) implies @Injectable().

@Injectable()
class QueueRegistry implements OnApplicationBootstrap {
  constructor(private readonly discovery: DiscoveryService) {}
  onApplicationBootstrap() {
    for (const { instance, meta } of this.discovery.providersWithMeta(QueueConsumer)) {
      if (!instance) continue; // request-scoped providers are not materialized
      this.register(instance, meta);
    }
  }
}
```

`providersWithMeta` (class-level) and `methodsWithMeta` (per-method — both
the appended-list convention and true handler metadata) resolve instances
through the container and honor its diagnostics mode (`throw`/`log`/`silent`)
in one place. Discovery is kernel-level (not encapsulation-scoped);
`DiscoveryFilter.moduleId` narrows when needed. These legacy methods return one
hit per class token; a filter resolves the first matching owner.

Dispatchers that support multiple module instances should use
`getRegistrations`, `registrationsWithMeta`, or `registeredMethodsWithMeta`.
They return one hit per class-token registration with an exact `moduleId` and
that owner's effective `scope`. Method hits carry ownership on `hit.class`.
`moduleIds` remains the full owner list for diagnostics. Registrations whose
provider token is a symbol/string rather than a class are not class discovery
candidates. Use `{ metadataOnly: true }` to read all scopes without constructing
providers or triggering lazy modules:

```ts
const handlers = discovery.registeredMethodsWithMeta(MyHandler, { metadataOnly: true });
for (const hit of handlers) {
  await runInEntrypointScope(container, async scope => {
    const instance = await scope.resolveAsync(hit.class.token, hit.class.moduleId);
    // Validate metadata and invoke through your transport's execution pipeline.
  });
}
```

`deferLazy` only defers pending lazy owners; `metadataOnly` defers every owner.
Neither fabricates a request context. Request-scoped hits come back with
`instance: undefined` unless the filter carries `requestScope`, an execution-scope
container of the current application (for example the `runInEntrypointScope`
callback argument); they are then resolved in, and owned by, that invocation. Discovery sees only the current
application's registrations.

## Entrypoints: the open non-HTTP surface

A module that dispatches non-HTTP work (WebSocket frames, queue batches,
scheduled ticks) declares an **entrypoint kind**; transports/adapters query
`app.entrypoints` instead of knowing module internals:

```ts
// Declarative — the kernel discovers annotated providers per kind:
registerEntrypointKind({ kind: 'queue', metaKey: QueueConsumer.KEY, level: 'class' });

// Computed — a dispatcher aggregates first, then contributes (authoritative
// for every kind it reports; overrides metaKey-derived entries of that kind):
class WsDispatcher implements ContributesEntrypoints {
  collectEntrypoints() { return [...this.gateways].map(g => ({ kind: 'websocket', ... })) }
}

// A transport / runtime adapter:
for (const ep of app.entrypoints.ofKind('websocket')) { ... }
```

Decorator-derived entries carry `entry.moduleId`, including request-scoped and
lazy registrations with `instance: undefined`. Resolve in the invocation's
container using `resolveAsync(entry.token, entry.moduleId)`. Computed contributors
should preserve the same owner field. It stays optional for existing 1.x
contributors; omission retains legacy unscoped resolution.

`entry.meta` is `unknown` by default. Pass a metadata parser as the second
argument to `ofKind(kind, parseMeta)` to validate it and infer its result type.

The registry is per-application, built at the end of
`callOnApplicationBootstrap()` — available on slim bootstrap paths (the
Cloudflare Durable Object) that never build HTTP routes.

## Routes: contributing generated routes

Custom metadata-based route generators can implement `RouteContributor` and
register at import time:

```ts
registerRouteContributor({
  id: 'my-generator',
  claimsMetaKey: 'pkg:my-meta',
  buildRoutes(app, { controller, controllerPrefix, meta, globalPrefix, globalGuards, container, joinPaths }) { ... },
  buildOpenApiPaths(ctx) { return { '/path/{id}': { get: {...} } }; },
});
```

Contributed routes are mounted **after** all explicit routes, and OpenAPI
paths merge verb-by-verb with hand-written ones.

Contributor-mounted routes bypass `RouteManager`, so they don't appear in
`app.describeRoutes()` / `vela route list` (shown as `(mounted)`) and get no
named-route `urlFor` support. For **first-class** generated routes, synthesize
real routes instead: define a prototype method, stamp it with the standard
verb decorators (`Get(path, { name })(proto, key, descriptor)`), and attach
params via `MetadataRegistry.addParameter(ctor, key, { index, type, metatype })`.
Synthesized methods have no `design:paramtypes`, so carry the schema descriptor as the
explicit `metatype` — `ValidationPipe` and the OpenAPI walk read it. Inside a
handler or `createParamDecorator` factory, `getRequestContainer(ctx.getContext())`
returns the request-scoped child container (plain `@Inject(Container)` yields
the root). This is the pattern the native `@velajs/crud` uses.

## Dispatch: reusing the pipeline

Custom dispatchers (queue consumers, schedulers) run handlers through
`PipelineRunner.run({ context, guards, interceptors, resolveArgs, invoke, onGuardReject })`
— the same guard → pipe → interceptor core HTTP and WebSocket use. Scoped
components come from the public
`resolveScopedComponents(type, class, method, container, moduleId)`: class-level,
then the owning module's `@Use*` components when the class is one of its
controllers, then method-level (reverse filters yourself for closest-first).
Pass the class's declaring `moduleId`: the loader registers the guard, pipe,
interceptor and filter classes a module's classes reference in that module, so
they resolve through the container like its providers.
Module-level entries are read from that application's module graph, never
copied onto the class, so repeated bootstraps in one isolate do not stack them.
`getScopedComponents(...)` returns the same declared entries without
constructing them, for audits and introspection. Whether app-wide components
apply is a transport decision: WS merges `RouteManager.getGlobalComponents()`;
queue/scheduled dispatch deliberately applies none. Exception-filter terminal
behavior stays transport-specific.

The worked example for ALL of this is the first-party queue module
(`packages/vela/src/queue/`, `@velajs/vela/queue`): decorators via
`createDiscoverableDecorator`, the `'queue'` entrypoint kind, per-job
`runInEntrypointScope` + async-seam re-resolution (lazy-module compatible),
`defineModule` for the global driver plus `registerQueue` dynamic modules that provide per-queue clients, native transport contributions, and
an import-audit test (`queue-openness.test.ts`) proving it never leaves the
public API. A custom transport dispatches one job with
`dispatchQueueJob(container, app.entrypoints, job)`, which honors the
application's `QueueModule` dispatch policy (registered queues, signed
re-entry) through the dispatcher native deliveries use; without a `QueueModule`
it calls the processors directly. It rejects a job no processor handles unless
called with `{ unhandled: 'ignore' }`, so a transport acknowledges a message
only when it resolves. After bootstrap the per-app `EntrypointRegistry` is also
injectable (global token) for providers that dispatch entrypoints themselves.

## Lazy modules: deferring cold-start init to first use

A module can opt out of eager bootstrap instantiation:

```ts
@Module({ lazy: true, providers: [MyRegistry], exports: [MyRegistry] })
class MyModule {}

// or, on the engine / per instance:
defineModule<Opts>({ name: 'X', lazy: true, ... })
XModule.forRoot({ ..., lazy: true })
// or on a hand-rolled definition:
{ module: XModule, lazy: true, providers: [...] }
```

**Semantics.** The module *instance* (class + `key`) is the unit of deferral.
None of its providers or controllers construct during `VelaFactory.create`;
the first resolution of ANY of its tokens — an injection by another provider,
`app.get()`, a request hitting one of its controllers, a dispatcher
re-resolving an entrypoint token — *claims* the module. Once the resolution
stack unwinds, the whole group materializes: every provider constructs (in
registration order) and its `onModuleInit` → `onApplicationBootstrap` hooks
replay, exactly once (memoized). Materialized instances join the app's
instance flow, so shutdown hooks run for them on `app.close()`; a module that
is never touched gets neither init nor shutdown hooks.

If the trigger happens *during* bootstrap (an eager consumer injects a lazy
export), the group is absorbed into the normal hook phases instead — with its
hooks ordered BEFORE the eager list (dependency-before-consumer), so e.g. a
lazy registry populates before an eager executor's hook reads it. Reading a
lazy module's `useValue` registrations (options tokens) does NOT trigger it.

**The sync seam rule.** `app.get()` and the request pipeline resolve
synchronously. A lazy module whose providers or lifecycle hooks are async is
only reachable through async seams — `app.materializeLazyModules()` (the
warmup escape hatch) or an async provider path — and a sync trigger throws a
descriptive error rather than silently skipping hooks. Keep lazy modules
fully sync, or don't mark them lazy.

**What can't be lazy.**
- *Self-driving modules* — anything that arms its own timers or listeners in
  a hook (`ScheduleNodeModule`'s executor). There is no external first
  trigger; nothing would ever start it.
- *Computed entrypoint contributors* are lazy-compatible but effectively
  eager: a `ContributesEntrypoints` provider in a lazy module is materialized
  right before the `app.entrypoints` snapshot (or its computed entries would
  be silently absent). Detection is static (class prototype), so contributors
  in lazy modules MUST be class providers (`Foo` or `useClass`) — a
  `useFactory`-produced contributor is invisible; keep its module eager. Decorator-declared kinds (`registerEntrypointKind`)
  defer fine: their entries appear metadata-only (`instance: undefined`) and
  dispatchers that re-resolve by token materialize the module per event.
- Constructors that *emit or dispatch during construction* observe pre-hook
  state in the live phase — same as bootstrap-phase semantics today; do
  side-effecting work in hooks, not constructors.

In-core lazy modules: `EventEmitterModule`, `ScheduleModule`, `SeederModule`,
`I18nModule`. `WebSocketModule` stays eager (its gateways are user providers
whose `@WebSocketServer()` injection drags the chain in anyway; transports
read gateway instances at wiring time).

## Cross-runtime modules (the WebSocket triad pattern)

1. **Edge-safe core** (`packages/vela/src/websocket/`): decorators + dispatcher + pluggable
   driver interfaces. No `node:*`, ever — CI-audited.
2. **Runtime transports** consume `app.entrypoints`, never module internals:
   `websocket-node` mounts Hono `upgradeWebSocket` routes; `@velajs/cloudflare`
   binds Durable Objects.
3. **Platform packages** implement `RuntimeAdapter`
   (`VelaFactory.create(m, { adapters: [...] })`): `requestMiddleware` runs
   before consumer middleware; `onBootstrap` before routes; `onRoutesBuilt`
   after.

## Checklist

- [ ] Module built on `defineModule` (or plain `@Module` when zero-config).
- [ ] Classes declared at module scope; runtime values arrive through
      `forRootAsync({ inject: [ENV] })`, providers or injectable classes.
- [ ] `key` deterministic; explicit `key` passthrough honored.
- [ ] Tokens are `InjectionToken`s (`moduleToken`), options token stable.
- [ ] Global components via the `global:` slot, `provideGlobal` or an
      `{ provide: APP_GUARD, useClass }` provider.
- [ ] Discovery via `DiscoveryService` / `createDiscoverableDecorator`.
- [ ] Non-HTTP surface exposed as entrypoints (`registerEntrypointKind` or
      `ContributesEntrypoints`).
- [ ] Generated routes use standard route metadata or `RouteContributor`.
- [ ] No `@velajs/vela/internal` imports; no `node:*` in edge code
      (`pnpm test` runs the edge audit).
- [ ] Two instances of your module in one app either dedup intentionally or
      coexist — test both.
- [ ] If `lazy: true`: providers and hooks are fully sync, nothing
      self-drives, and construction does no dispatching — see "Lazy modules".

See [module-based Workers](module-workers.md) for queue, cron, RPC and deployment composition.
