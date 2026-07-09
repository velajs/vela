# Authoring Vela Modules

The contract for building a Vela feature module — first-party or third-party.
Everything here is public API from `@velajs/vela`; a module never needs
`@velajs/vela/internal`.

## The blessed path: `defineModule`

One engine generates `forRoot` **and** `forRootAsync`, derives a
deterministic instance `key`, and lets every contribution be a function of
the options:

```ts
import { defineModule, InjectionToken, stableHash } from '@velajs/vela';

export interface StorageOptions { name?: string; driver: () => StorageDriver; http?: boolean }
export const STORAGE_OPTIONS = new InjectionToken<StorageOptions>('STORAGE_OPTIONS');

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<StorageOptions>({
  name: 'Storage',
  optionsToken: STORAGE_OPTIONS,               // keep token identity across refactors
  key: (o) => stableHash({ name: o.name }),    // optional; default stableHash(options)
  setup: ({ OPTIONS, options, key }) => ({     // runs once per instance, at call time
    providers: [
      { provide: DRIVER, useFactory: (o: StorageOptions) => o.driver(), inject: [OPTIONS] },
    ],
    controllers: options.http ? [createStorageController(options)] : [],
    exports: [DRIVER],
    global: { guards: [StorageGuard] },        // one idiom for APP_* wiring
  }),
});
export class StorageModule extends ConfigurableModuleClass {}
```

- `forRootAsync({ inject, useFactory })` comes free, with typed factory
  params inferred from the `inject` tuple. Structural fields passed alongside
  the factory merge **under** the resolved options (factory wins).
- `ConfigurableModuleBuilder` (NestJS parity) is a thin adapter over
  `defineModule` — same engine, either entry.
- `defineConfigurableModule` remains the low-level engine for
  runtime-generated module classes (Cloudflare binding modules).

### Keys (multi-instance dedup)

`DynamicModule.key` decides instance identity: same `(class, key)` dedups
(HMR-idempotent), different keys coexist. Rules:

1. Default `stableHash(options)` is right for value-shaped options.
2. Options carrying **stateful instances** (drivers, registries, sockets)
   must use `key: (o) => ...` over the stable identifying subset — never a
   counter (non-deterministic keys break HMR dedup), and never rely on
   `stableHash` of closures (identical source hashes collide).
3. Always honor the caller's explicit `key` (`defineModule` does).

### Tokens

Mint with `moduleToken<T>('pkg:area:thing')` (an `InjectionToken`) — never
raw strings. Pass existing tokens via `optionsToken` when migrating so
downstream `@Inject(...)` keeps working.

### Companion primitives

- `lazyProvider({ provide, inject, useFactory, memoize? })` — provides a
  memoized thunk `() => T` whose factory runs on first call (for values not
  live at bootstrap, e.g. Cloudflare bindings).
- `provideGlobal(kind, component)` — spread into `providers:` to register an
  app-wide guard/pipe/interceptor/filter/middleware outside `defineModule`.
- `sideEffectModule(name, contributions)` — a contribution-only dynamic
  module (the supported form of i18n's `registerMessages` pattern);
  content-derived key so identical contributions dedup.

## Discovery: finding decorated providers

Never hand-roll a `container.getTokens()` scan. Declare a decorator, then ask
`DiscoveryService`:

```ts
export const QueueConsumer = createDiscoverableDecorator<{ queue: string }>('pkg:queue:consumer');
// stackable method decorators: createDiscoverableDecorator(key, { append: true })

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
`DiscoveryFilter.moduleId` narrows when needed.

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
for (const ep of app.entrypoints.ofKind<WsEntrypointMeta>('websocket')) { ... }
```

The registry is per-application, built at the end of
`callOnApplicationBootstrap()` — available on slim bootstrap paths (the
Cloudflare Durable Object) that never build HTTP routes.

## Routes: contributing generated routes

Metadata-claimed route generators (what `@Crud()` does) implement
`RouteContributor` and register at import time:

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
Synthesized methods have no `design:paramtypes`, so carry the DTO class as the
explicit `metatype` — `ValidationPipe` and the OpenAPI walk read it. Inside a
handler or `createParamDecorator` factory, `getRequestContainer(ctx.getContext())`
returns the request-scoped child container (plain `@Inject(Container)` yields
the root). This is the pattern the native `@velajs/crud` (>=1.18) uses.

## Dispatch: reusing the pipeline

Custom dispatchers (queue consumers, schedulers) run handlers through
`PipelineRunner.run({ context, guards, interceptors, resolveArgs, invoke, onGuardReject })`
— the same guard → pipe → interceptor core HTTP and WebSocket use. Scoped
components come from the public
`resolveScopedComponents(type, class, method, container)` (declaration order;
reverse filters yourself for closest-first). Whether app-wide components
apply is a transport decision: WS merges `RouteManager.getGlobalComponents()`;
queue/scheduled dispatch deliberately applies none. Exception-filter terminal
behavior stays transport-specific.

The worked example for ALL of this is the first-party queue module
(`src/queue/`, `@velajs/vela/queue`): decorators via
`createDiscoverableDecorator`, the `'queue'` entrypoint kind, per-job
`runInEntrypointScope` + async-seam re-resolution (lazy-module compatible),
`defineModule({ lazy: true })` with options-derived per-queue providers, and
an import-audit test (`queue-openness.test.ts`) proving it never leaves the
public API. Dispatch one unit of platform work with
`dispatchQueueJob(container, app.entrypoints, job)`; after bootstrap the
per-app `EntrypointRegistry` is also injectable (global token) for providers
that dispatch entrypoints themselves.

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

1. **Edge-safe core** (`src/websocket/`): decorators + dispatcher + pluggable
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
- [ ] `key` deterministic; explicit `key` passthrough honored.
- [ ] Tokens are `InjectionToken`s (`moduleToken`), options token stable.
- [ ] Global components via the `global:` slot / `provideGlobal` only.
- [ ] Discovery via `DiscoveryService` / `createDiscoverableDecorator`.
- [ ] Non-HTTP surface exposed as entrypoints (`registerEntrypointKind` or
      `ContributesEntrypoints`).
- [ ] Generated routes via `RouteContributor`.
- [ ] No `@velajs/vela/internal` imports; no `node:*` in edge code
      (`pnpm test` runs the edge audit).
- [ ] Two instances of your module in one app either dedup intentionally or
      coexist — test both.
- [ ] If `lazy: true`: providers and hooks are fully sync, nothing
      self-drives, and construction does no dispatching — see "Lazy modules".
