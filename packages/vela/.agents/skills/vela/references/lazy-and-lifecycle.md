# Lazy Modules, Lifecycle Hooks & Entrypoints

How Vela boots, shuts down, defers cold-start work, and exposes non-HTTP entry surfaces. All on `@velajs/vela`.

## Lifecycle hooks

Implement any of these interfaces on a provider or module class:

```ts
interface OnModuleInit             { onModuleInit(): void | Promise<void>; }
interface OnApplicationBootstrap   { onApplicationBootstrap(): void | Promise<void>; }
interface BeforeApplicationShutdown{ beforeApplicationShutdown(signal?: string): void | Promise<void>; }
interface OnModuleDestroy          { onModuleDestroy(): void | Promise<void>; }
interface OnApplicationShutdown    { onApplicationShutdown(signal?: string): void | Promise<void>; }
```

**Startup order** (forward, over module/provider load order): every `onModuleInit` runs, then every `onApplicationBootstrap`. `VelaFactory.create` awaits both before returning.

**Shutdown order** (reverse) when you call `await app.close(signal?)`: `beforeApplicationShutdown` → `onModuleDestroy` → `onApplicationShutdown`. `app.dispose()` additionally disposes container instances LIFO, and `app` is wired to `Symbol.asyncDispose` so `await using app = await VelaFactory.create(...)` tears down automatically.

```ts
@Injectable()
class Cache implements OnApplicationBootstrap, OnApplicationShutdown {
  onApplicationBootstrap() { /* warm up */ }
  onApplicationShutdown(signal?: string) { /* flush */ }
}
```

## Lazy modules

Mark a module `lazy: true` to skip eager instantiation — none of its providers/controllers construct during `VelaFactory.create`:

```ts
@Module({ lazy: true, providers: [HeavyRegistry], exports: [HeavyRegistry] })
class HeavyModule {}
```

The module **instance** (class + key) is the unit of deferral. The first resolution of ANY of its tokens — an injection, `app.get()`, a request hitting one of its controllers, a dispatcher re-resolving an entrypoint token — *claims* the module; once the resolution stack unwinds, the whole group materializes (providers construct in order, `onModuleInit` → `onApplicationBootstrap` replay once). A module never touched gets neither init nor shutdown hooks.

If the trigger happens *during* bootstrap (an eager consumer injects a lazy export), the group is absorbed into the normal hook phases, ordered before the eager list (dependency-before-consumer).

### The sync-seam rule

`app.get()` and `Container.resolve()` resolve **synchronously**. The HTTP pipeline and owner-aware async dispatchers use `resolveAsync()`. A lazy module whose providers or hooks are async needs one of these async paths or `app.materializeLazyModules()` for explicit warmup. A sync trigger against an async lazy module throws a descriptive error rather than silently skipping hooks:

```
[vela] lazy module 'X' has async providers or lifecycle hooks and was triggered
through a synchronous resolution path. Reach it through an async seam first
(app.materializeLazyModules(), an async provider) or remove lazy: true.
```

Keep providers and hooks synchronous when callers need a synchronous lookup, or materialize the module through an async path first.

### What can't be lazy

- **Self-driving modules** (arm their own timers/listeners in a hook, e.g. `ScheduleNodeModule`'s executor) — nothing would trigger them.
- **Computed entrypoint contributors** must be class providers (a `useFactory`-produced `ContributesEntrypoints` is invisible to static detection — keep its module eager).
- Constructors that emit/dispatch during construction observe pre-hook state — do side effects in hooks.

In-core lazy modules: `EventEmitterModule`, `ScheduleModule`, `SeederModule`, `I18nModule`, `QueueModule`. `WebSocketModule` stays eager.

## Entrypoints — the non-HTTP surface

Modules that dispatch non-HTTP work (WebSocket frames, queue batches, cron ticks) declare an **entrypoint kind**; transports query `app.entrypoints` instead of module internals. The per-app registry is built at the end of bootstrap (available even on slim, route-less paths like a Cloudflare Durable Object).

```ts
// Declarative: kernel discovers annotated providers per kind
registerEntrypointKind({ kind: 'queue', metaKey: PROCESSOR_METADATA, level: 'class' });

// Computed: a dispatcher aggregates then contributes
class WsDispatcher implements ContributesEntrypoints {
  collectEntrypoints() { return [...this.gateways].map(g => ({ kind: 'websocket', /* ... */ })); }
}

// A transport / runtime adapter reads them:
for (const ep of app.entrypoints.ofKind('websocket')) { /* validate ep.meta with the transport's parser before use */ }
```

`ofKind(kind)` returns unknown metadata; `ofKind(kind, parseMeta)` infers validated metadata from the parser. A kind string alone does not establish a metadata type.

`app.entrypoints` throws if accessed before bootstrap completes. Decorator-derived records include their owning `moduleId`. Custom contributors should supply that owner too; `resolveEntrypoint(scope, entry)` rejects an omitted owner when the token has multiple registrations. Reuse `PipelineRunner.run(...)` and `resolveScopedComponentsAsync(kind, target, method, scope, moduleId)`; global component policy remains transport-specific. See `invocation-scopes.md` and the repo's `docs/modules.md`.
