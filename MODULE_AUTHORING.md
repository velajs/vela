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

## Dispatch: reusing the pipeline

Custom dispatchers (queue consumers, schedulers) run handlers through
`PipelineRunner.run({ context, guards, interceptors, resolveArgs, invoke, onGuardReject })`
— the same guard → pipe → interceptor core HTTP and WebSocket use. Merge
global components from `RouteManager.getGlobalComponents()` with
`ComponentManager.getScopedComponents(...)`; exception-filter terminal
behavior stays transport-specific.

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
