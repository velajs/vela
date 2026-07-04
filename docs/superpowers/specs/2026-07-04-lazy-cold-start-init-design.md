# Lazy cold-start subsystem init — design

**Status**: approved for implementation (session-autonomous; roadmap phase 3)
**Scope**: `factory/bootstrap.ts`, `factory.ts`, `module/module-loader.ts`, `container/`, `application.ts`, plus module-metadata surface (`registry/types.ts`, `module/decorators.ts`, `module/define-module.ts`), `discovery/discovery.service.ts` (one filter branch), `entrypoint/entrypoint.registry.ts` (build-time deferral), and `lazy: true` flags on first-party modules.
**Out of scope**: `src/errors/`, `http/handler-executor.ts` (owned by a parallel session), `RouteManager`, any change to the WebSocket module's chained factories.

## Problem

`VelaFactory.create` → `loader.resolveAllInstances()` constructs **every**
non-request provider and controller at startup, then runs
`onModuleInit`/`onApplicationBootstrap` over all of them, then
`EntrypointRegistry.build` force-resolves every decorated provider a second
way. An HTTP-only worker pays for machinery it never uses:

- **event-emitter**: `EventEmitterSubscriber.onApplicationBootstrap` resolves
  every `@OnEvent`-carrying class and binds listeners.
- **schedule**: `ScheduleRegistry.onApplicationBootstrap` resolves every
  `@Cron`/`@Interval` class; `EntrypointRegistry.build` resolves them again
  for the `cf:vela-cron` kind.
- **i18n**: `MessageLoaderService` constructor deep-merges the entire message
  tree.
- **websocket**: gateway classes + chained registry→driver→server factories
  all construct (including a Redis subscribe for `redis()` sync).
- **seeder**: `SeederRegistry` hook scans and resolves seeder classes.

## Constraints (test-pinned + downstream)

1. `bootstrap()` alone must not instantiate providers or run hooks
   (`bootstrap-consolidation.test.ts`).
2. Never-injected providers with lifecycle hooks in **non-lazy** modules must
   run their hooks at `create()` in registration order
   (`nestjs-parity.test.ts:1424`). ⇒ laziness is strictly **opt-in**.
3. `app.entrypoints` must be complete (enumerable) immediately after
   `callOnApplicationBootstrap()` — cloudflare `scheduled()`/`queue()`/DO
   transports and `registerWebSocketRoutes` read it at wiring time.
4. `ContributesEntrypoints` contributors (WsDispatcher) must be instantiated
   with hooks run **before** the registry builds — the `'websocket'` kind
   exists only through that path.
5. The three bootstrap call sites (`factory.ts`, cloudflare
   `do-bootstrap.ts`, testing `testing-module.builder.ts`) share the sequence
   `resolveAllInstances → setInstances → callOnModuleInit →
   callOnApplicationBootstrap`; the mechanism must ride inside those calls so
   downstream packages keep working **unchanged**.
6. Shutdown symmetry: any instance materialized after bootstrap must still
   receive shutdown hooks on `app.close()` (`health.test.ts:338` pattern).
7. Edge purity: no `node:*`, no timers, pure TS.

## Design

### Opt-in surface

- `@Module({ lazy: true })` — static class metadata (`ModuleOptions.lazy`).
- `DynamicModule.lazy?: boolean` — per returned definition.
- `defineModule`: `lazy` becomes a recognized extra like `isGlobal`
  (`forRoot({ lazy: true })`), and a spec can default it
  (`extras: { lazy: true }`). The default transform lowers it onto the
  definition.

Laziness is **module-instance-granular** (`moduleId` = class+key): the unit of
deferral is the module's whole provider group, because hook correctness is a
group property (dispatcher + registry + driver chains).

### Loader (`module-loader.ts`)

- `processModule` records lazy module instances: `moduleId` → ordered token
  list (providers then controllers, registration order). Controllers of a lazy
  module still register with `RouteManager` (routes exist; the controller
  constructs on first request — that resolution is itself the trigger).
- `resolveAllInstances()` skips tokens **all** of whose registrations live in
  lazy buckets (a token also registered by an eager module stays eager).
- New `getLazyGroups(): LazyModuleGroup[]`.

### `LazyModuleManager` (new, `module/lazy-modules.ts`)

Created inside `bootstrap()`, registered as a global framework primitive
(like `DiscoveryService`), and handed to the container. State:

- `pending: Map<moduleId, LazyModuleGroup>`; single-flight `inFlight` set;
- `phase: 'bootstrap' | 'live'`;
- `absorbed: unknown[]` — instances constructed during the bootstrap window;
- `onMaterialized` sink (wired by `VelaApplication`).

`materialize(moduleId, mode)`:
1. Delete from `pending` first (memoization); mark in-flight (re-entrant
   resolves construct directly without re-triggering).
2. Construct every group token via the container (nested lazy deps cascade).
3. `phase === 'bootstrap'` → queue instances into `absorbed`; hooks run in the
   app's normal phases.
   `phase === 'live'` → run `onModuleInit` then `onApplicationBootstrap`
   across the group's new instances (registration order), then hand them to
   `onMaterialized` so the app appends them to `instances` (shutdown
   symmetry).
4. **Sync/async duality**: the container trigger can fire inside a
   synchronous `resolve()`. Construction uses sync resolution; if a hook
   returns a thenable on the sync path, throw a descriptive error naming the
   module and the fix (keep the module eager, or reach it through an async
   seam first). Async callers (`resolveAsync`, entrypoint materialization,
   `app.materializeLazyModules()`) await everything.

### Container

- `setLazyHook(hook)` — carried by reference into `createChild()` and
  `createDetached()` children.
- In `resolveRegistration` (the single construction seam for sync resolve and
  the class path of `resolveAsync`) and in `resolveAsync`'s factory branch:
  after the cache-hit checks, if `registration.declaringModuleId` is
  lazy-pending → `hook.materialize(moduleId, mode)` first, then construct
  (now typically a cache hit).
- `isLazyPending(token): boolean` — for discovery/entrypoint deferral.

### Discovery (`discovery.service.ts`)

Default behavior **unchanged**: `buildEntry` resolves through the container,
which now transparently materializes lazy owners — every existing scanner
(EventEmitterSubscriber, ScheduleRegistry, WsDispatcher, hand-rolled seeder
scan) stays correct with zero edits, cascading materialization only when the
scanner itself runs.

One new filter flag: `DiscoveryFilter.deferLazy?: boolean`. When set and the
provider is lazy-pending, return the entry with `instance: undefined`
(mirroring the existing request-scoped convention). Only
`EntrypointRegistry.build` uses it.

### Application + entrypoints

`callOnApplicationBootstrap()` becomes:
1. Run `onApplicationBootstrap` for `instances` (after `callOnModuleInit`
   already drained `absorbed` once); loop draining `absorbed` — newly
   absorbed groups get both hooks — until stable.
2. Flip manager to `'live'`.
3. Materialize (await) every still-pending lazy module whose class providers'
   prototypes declare `collectEntrypoints` (static detection — no instance
   needed). Constraint 4 preserved: computed contributors are effectively
   eager; that is the documented cost of contributing computed entrypoints.
4. `EntrypointRegistry.build(discovery, instances, { deferLazy: true })`:
   metaKey-declared kinds owned by lazy-pending modules produce
   **metadata-only entries** (`instance: undefined`, token + meta +
   methodName present). Dispatchers already re-resolve by token per event
   (cloudflare cron/queue), which triggers materialization at dispatch time.

`close()`/`dispose()` operate on `instances`, which now includes everything
materialized post-bootstrap. New public `app.materializeLazyModules():
Promise<void>` materializes all pending groups (warmup / tests / node
runtimes that want eager-everything back).

**Hook ordering**: absorbed instances run their hooks **before** the eager
list (dependency-before-consumer: a group absorbed because an eager provider
injected it must be initialized first — e.g. ScheduleRegistry's hook must
precede ScheduleExecutor's read of it).

### First-party lazy defaults (this change)

`EventEmitterModule`, `I18nModule`, `ScheduleModule`, `SeederModule` →
`lazy: true`. Behavior stays observably identical because every consumer path
is a trigger (`app.get(EventEmitter)`, request middleware for i18n,
`app.get(ScheduleRegistry)`, seeder `runAll()`).

Stays eager: `WebSocketModule` (chained factories + `ContributesEntrypoints`
+ transports read gateway instances at wiring time), `ScheduleNodeModule`
(wall-clock timers must arm at bootstrap; its `ScheduleRegistry` dependency
absorbs the schedule group at bootstrap automatically), `HealthModule`,
`CorsModule` (trivial cost, shutdown-flag semantics).

## Alternatives rejected

- **Provider-level lazy metadata**: hooks and chained factories are
  group-coherent; per-provider deferral lets half a subsystem materialize
  (driver without registry) — exactly the bug class the 1.11 chained-factory
  design eliminated. `lazyProvider` already covers the value-level case.
- **Infer laziness (defer everything, replay hooks on demand)**: breaks
  pinned eager contracts (constraint 2), silently changes third-party hook
  timing, and forces the entrypoint registry to become fully lazy (async
  `ofKind`), rippling a breaking change through every transport for no
  opt-in.
- **Async `EntrypointRegistry.ofKind` with per-kind materialization**: purest
  laziness for computed contributors, but breaks the sync wiring contract in
  three packages; revisit only if a metadata-only WS contribution lands in
  `@velajs/cloudflare` first.

## Failure modes addressed

- Lazy module with async hooks reached through a sync seam → descriptive
  error (names module, hook, remedies), never a silent skip.
- Nested lazy→lazy dependency → cascade with in-flight marking (no
  double-materialize, no deadlock).
- Token in lazy AND eager buckets → eager wins, no deferral.
- Group hook failure → propagate (memoized as attempted; container state
  consistent because pending was cleared first — matches "hooks throw at
  create()" semantics for eager modules).
- Never-materialized group at `close()` → no instances, no hooks, correct.

## Tests

1. **Cold-start regression** (new file): HTTP-only app importing
   EventEmitter/I18n/Schedule/Seeder modules + a lazy user module with
   `@OnEvent`+`@Cron` classes and constructor counters → `create()`
   constructs none of them; first trigger constructs the group exactly once
   (memoized); hooks replay once; `getInstances()` grows; `close()` runs
   shutdown hooks on materialized instances.
2. Trigger seams: `app.get`, controller-route hit (lazy module controller),
   entrypoint dispatch re-resolve, `materializeLazyModules()`.
3. Ordering: absorbed-group hooks before eager hooks
   (registry-before-executor); `ContributesEntrypoints` lazy module
   materialized before registry build.
4. Sync-seam + async hook → descriptive throw.
5. Entrypoint metadata-only entries for lazy modules; eager modules keep
   resolved `instance` (existing `discovery-entrypoints` tests unchanged).
6. All 861 existing tests + `test:workers` green **unchanged** — the flipped
   first-party defaults must be observably transparent.

---

## Amendments (reconciliation, 2026-07-04)

This spec was authored by a concurrent session; this session verified it
against the codebase and adopts it with the following amendments. Where the
amendments and the text above conflict, the amendments win.

### A1 — Trigger is claim-and-queue; group completion + hook replay happen at
drain points, not inline

The container trigger (`resolveRegistration` / `resolveAsync` factory branch,
after the cache checks) does NOT construct the whole group inline. It only
*claims* the module (removes it from pending, enqueues the group) and lets the
requested registration construct through the normal machinery. The queued
group is completed — remaining tokens constructed, then hooks absorbed
(bootstrap phase) or replayed (live phase) — at a **drain point**: when the
sync `resolutionStack` is empty AND no `resolveAsync` cascade is in flight
(an async-depth counter). `resolveAsync` drains in async mode (awaits hook
promises); sync `resolve` drains in sync mode and throws the descriptive
error if a hook or member factory yields a thenable.

Why: (1) inline group construction runs the group's `onApplicationBootstrap`
discovery passes while a resolution stack may be live — a discovery
force-resolve of a class currently mid-construction (an `@OnEvent` method on
the very service being constructed) produces a spurious circular-dependency
error, which in `log` diagnostics mode silently drops the subscription
forever; (2) a lazy module containing an async factory provider would explode
inside a synchronous construction cascade even on async seams. Draining at
stack-unwind closes both. Consequence (documented): code that uses a
just-materialized subsystem *inside a constructor or factory body* in the
live phase observes pre-hook state — identical to today's bootstrap-phase
behavior, where wiring happens in `callOnApplicationBootstrap` after all
construction.

The drain must be reentrant-safe: hook replays can claim further lazy modules
(discovery cascades); the drain loop keeps going until the queue is empty,
and nested drain attempts no-op.

### A2 — RouteManager priority-probe skip (one-line seam)

`RouteManager.getMiddlewarePriority` force-instantiates middleware entries at
route build when no static `priority` is readable (route.manager.ts:224).
Without a guard this materializes `I18nModule` (via the `I18nLocaleMiddleware`
APP_MIDDLEWARE token) at `initRoutes` — defeating its laziness. Amendment:
before the instantiate-probe, if the entry is a token whose only
registrations are lazy-pending (`container.isLazyPending(token)`), return
default priority 0. This is one guard clause in `getMiddlewarePriority`; the
handler-executor catch path and `src/errors/` remain untouched.

### A3 — Metadata-only entrypoint entries: VERIFIED safe

The claim that dispatchers re-resolve by token per event is confirmed:
`@velajs/cloudflare` `cloudflare-application.ts:175` (`ep.token as Type`) and
`:180` (`scope.resolve(ep.token)`), for `cf:scheduled`, `cf:vela-cron`, and
`cf:queue`. `DiscoveryFilter.deferLazy` + metadata-only entries stand as
specified.

### A4 — Container diagnostics helpers

`Container.isLazyPending(token)` (all owning registrations belong to
lazy-pending scopes) — used by A2 and by `EntrypointRegistry.build`'s
deferLazy filter path; `Container.isInstantiated(token)` (any owning
registration holds a constructed instance) — used by cold-start regression
tests to assert non-instantiation without triggering resolution.

### A5 — useValue reads do not trigger

The trigger sits after the `useValue` early-return, so reading a lazy
module's `useValue` registration (options tokens) does not materialize the
group. There is no construction cost to defer, and options tokens are
consumed by the group's own factories anyway. Documented, deliberate.

### A6 — Worktree/coordination note

Implemented on branch `worktree-lazy-cold-start-init` (isolated worktree) due
to a concurrent sibling session sharing the main working tree. A claim marker
(`CLAIMED-lazy-cold-start-init.md`) was left beside the spec in the main
tree.

### A7 — Post-review hardening (adversarial multi-agent review, 2026-07-04)

Confirmed by independent reproduction and fixed:
1. **drainAsync self-await deadlock** (critical): with ≥2 claimed groups, the
   drain loop's own `resolveAsync` calls re-entered `drainAsync` via the
   container's end-of-cascade check and awaited the in-flight drain promise —
   a self-referential await hanging `create()` / `materializeLazyModules()`.
   Fix: `LazyResolutionHook.isDraining()`; the container never starts or
   awaits a drain while one is running (the loop picks pending claims up).
   External concurrent callers still await the shared in-flight promise.
   Corollary (documented): do not await `materializeLazyModules()` from
   inside a lifecycle hook.
2. **Nested lazy→lazy hook-order inversion** (major): drains now construct
   the whole claim cascade first, then run hook phases over the REVERSED
   batch (claims arrive consumer-before-dependency) — init for all, then
   bootstrap for all — restoring eager-parity dependency-before-consumer
   order in both live and bootstrap-absorption phases.
3. **Double hooks for a token shared by lazy + eager modules** (major):
   the application now identity-dedups the instance flow (eager pass +
   absorbed batches + live materializations).
4. **`createDetached()` bypass** (major): sandboxes (`ModuleRef.create`) now
   share the real root, so sandbox resolution of a lazy registration claims
   and replays hooks instead of poisoning the shared singleton cache with a
   hook-less instance.
5. **Testing-builder wiring gap** (critical): fixed by arming the manager
   from `ModuleLoader.load()` (cherry-picked from the sibling session's
   `feat/lazy-init-hardening`).
6. **useFactory `ContributesEntrypoints` undetectable** (minor, documented):
   computed-entrypoint contributors in lazy modules must be class providers
   (static prototype detection); `useFactory` contributors require an eager
   module.
