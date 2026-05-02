# vela — Integration Roadmap for erpos

This document tracks the changes vela needs to land to support **erpos** (an SDK-first, edge-portable ERP/CRM/marketing platform that uses vela as its DI host). It is owned by the same maintainer as vela, so this is internal coordination, not external negotiation.

The doc is structured around a concrete question: **what changes in vela are blockers for erpos kernel work, and what is the right sequencing?**

erpos's full architecture lives in the erpos repo's `docs/`. This doc is self-contained for vela; you don't need erpos context to act on it.

---

## TL;DR

**Two changes are critical-path blockers for erpos kernel work**:

1. **Module visibility enforcement** (audit findings #1 + #2) — ✅ DONE in vela 1.2.0
2. **Bootstrap consolidation** (audit finding #3) — ✅ DONE in vela 1.2.0

**Three more should land in the same release** to avoid kernel hacks accumulating:

3. **Strict mode + structured discovery diagnostics** (audit findings #4 + #6) — ✅ DONE in vela 1.2.0
4. **Workers vitest config** (lock the edge-runtime claim with live tests, not just static scan) — ⏳ deferred
5. **Plugin manifest type + composer** (new — a `definePlugin`-style helper that takes `Plugin[]` → `DynamicModule`) — ✅ DONE in vela 1.2.0

The remaining audit items (#5 type cleanup, #7 edge-contract docs, #8 metadata stores, #9 RouteManager split, #10 compiler strictness) are real but defer-able.

Target release: **vela 1.2.0**, before erpos kernel P0 begins.

---

## Why these changes matter (impact analysis)

erpos uses vela as its **DI host + decorator runtime + lifecycle host**. Plugin authors don't import from vela directly — the `@erpos/kernel` package translates SDK declarations (`definePlugin`, `defineEntity`, `defineEvent`, `defineAgentTool`, `defineSlot`) into vela module compositions internally.

This indirection has a critical implication: **every guarantee the kernel offers plugin authors must be backed by a primitive in vela**. If vela can't enforce module isolation, the kernel can't promise plugin sandboxing. If vela's bootstrap is duplicated and drifting, the kernel's CLI tools (`erpos migrate`, `erpos plugin:inspect`, `erpos custom-fields:promote`) will diverge from runtime behavior.

The audit findings in `CODE_AUDIT_REPORT.md` are accurate. erpos pushes vela's existing scope farther — multi-tenant, multi-plugin, agent-bearing workloads. The audit items that touch correctness must land before erpos starts.

---

## Tier 1 — TRUE BLOCKERS (must land before erpos kernel P0)

### 1. Module visibility enforcement (audit #1 + #2)

**Problem (from `CODE_AUDIT_REPORT.md`)**:

> Module boundaries are NOT enforced. `Container.resolve()` auto-registers any class token, so a service can resolve dependencies its module never imported.
>
> Dynamic module identity is inconsistent — some modules cache by class; `HttpModule.register()` uses synthetic throwaways via `createModuleRef()`; repeated dynamic imports with different options can be silently collapsed.

**Why this is a blocker for erpos**:

erpos's plugin contract assumes module boundaries are real:

- A CRM plugin must NOT silently grab Marketing's internal `LeadEnrichmentService` even if it exists in the DI container
- Third-party plugins (eventual marketplace goal) cannot be allowed to bypass the SDK by reaching into kernel internals
- `definePlugin({ dependsOn: ['crm'] })` is meaningless if any plugin can resolve any provider

This is not a polish issue — without it, **plugin sandboxing is theatrical**, and the entire SDK-first architecture is built on a falsehood.

**Why the kernel cannot work around it**:

The Container is the choke point. Anything that wraps it (middleware, interceptor, decorator) only sees resolutions after they've succeeded. Enforcing visibility requires intercepting `resolve()` itself — which means modifying vela.

### Sketch — `src/registry/types.ts`

```ts
export interface ModuleScope {
  moduleId: string
  localProviders: Set<InjectionToken>          // declared in @Module({ providers })
  importedModules: Set<string>                  // declared in @Module({ imports })
  exportedTokens: Set<InjectionToken>           // declared in @Module({ exports })
  isGlobal: boolean                             // declared via @Global()
}

export class ModuleVisibilityError extends Error {
  constructor(public readonly moduleId: string, public readonly token: InjectionToken) {
    super(
      `Module '${moduleId}' cannot resolve '${tokenName(token)}': ` +
      `not declared in providers, not imported from another module's exports, not @Global. ` +
      `Either add to imports/exports or mark as @Global.`,
    )
  }
}
```

### Sketch — `src/container/container.ts`

```ts
export interface Container {
  resolve<T>(token: InjectionToken<T>, requestingModuleId?: string): T
  resolveAll<T>(token: InjectionToken<T>, requestingModuleId?: string): T[]
}

class ContainerImpl implements Container {
  private scopes = new Map<string, ModuleScope>()
  private globals = new Set<InjectionToken>()
  private strict: boolean

  constructor(opts: { strict: boolean }) {
    this.strict = opts.strict
  }

  registerScope(scope: ModuleScope): void {
    this.scopes.set(scope.moduleId, scope)
    if (scope.isGlobal) {
      for (const token of scope.localProviders) this.globals.add(token)
    }
  }

  resolve<T>(token: InjectionToken<T>, requestingModuleId?: string): T {
    if (this.strict && requestingModuleId !== undefined) {
      this.assertVisible(requestingModuleId, token)
    }
    return this.doResolve(token)
  }

  private assertVisible(moduleId: string, token: InjectionToken): void {
    const scope = this.scopes.get(moduleId)
    if (!scope) {
      throw new Error(`Unknown module '${moduleId}' attempting to resolve '${tokenName(token)}'`)
    }

    const visibleLocally = scope.localProviders.has(token)
    const visibleViaImport = this.isExportedFromImports(scope, token)
    const visibleAsGlobal = this.globals.has(token)

    if (!visibleLocally && !visibleViaImport && !visibleAsGlobal) {
      throw new ModuleVisibilityError(moduleId, token)
    }
  }

  private isExportedFromImports(scope: ModuleScope, token: InjectionToken): boolean {
    for (const importedId of scope.importedModules) {
      const imported = this.scopes.get(importedId)
      if (imported?.exportedTokens.has(token)) return true
      // Re-exports through transitive imports
      if (imported && this.isExportedFromImports(imported, token)) return true
    }
    return false
  }
}
```

### Sketch — `src/module/module-loader.ts`

The `ModuleLoader` walks the module tree and registers each scope:

```ts
async function loadModule(meta: ModuleMetadata, container: Container): Promise<void> {
  const moduleId = meta.id ?? meta.classRef.name

  const scope: ModuleScope = {
    moduleId,
    localProviders: new Set(meta.providers.map(tokenOf)),
    importedModules: new Set(meta.imports.map(m => m.id ?? m.classRef.name)),
    exportedTokens: new Set(meta.exports.map(tokenOf)),
    isGlobal: meta.isGlobal,
  }
  container.registerScope(scope)

  for (const importedMeta of meta.imports) {
    await loadModule(importedMeta, container)
  }

  // Instantiate providers, threading the moduleId so injection tracks origin
  for (const provider of meta.providers) {
    container.instantiate(provider, moduleId)
  }
}
```

When the framework injects dependencies into a constructor, it passes the **declaring** module id as `requestingModuleId`:

```ts
// src/container/instantiation.ts
function instantiate<T>(ctor: Type<T>, declaringModuleId: string): T {
  const params = getParamTypes(ctor)
  const deps = params.map(token => this.resolve(token, declaringModuleId))
  return new ctor(...deps)
}
```

### Tests — `src/__tests__/module-visibility.test.ts`

```ts
describe('module visibility (strict mode)', () => {
  beforeEach(() => MetadataRegistry.clear())

  it('rejects cross-module resolution when token is not exported', async () => {
    @Injectable() class ServiceA {}
    @Injectable() class ServiceB { constructor(public a: ServiceA) {} }

    @Module({ providers: [ServiceA] }) class ModA {}                     // not exported
    @Module({ imports: [ModA], providers: [ServiceB] }) class ModB {}

    await expect(VelaFactory.create(ModB, { strict: true }))
      .rejects.toThrow(ModuleVisibilityError)
  })

  it('allows resolution when token is exported', async () => {
    @Injectable() class ServiceA {}
    @Injectable() class ServiceB { constructor(public a: ServiceA) {} }

    @Module({ providers: [ServiceA], exports: [ServiceA] }) class ModA {}
    @Module({ imports: [ModA], providers: [ServiceB] }) class ModB {}

    const app = await VelaFactory.create(ModB, { strict: true })
    expect(app.container.resolve(ServiceB, 'ModB').a).toBeInstanceOf(ServiceA)
  })

  it('allows @Global tokens regardless of imports', async () => {
    @Global() @Injectable() class GlobalSvc {}
    @Injectable() class Consumer { constructor(public g: GlobalSvc) {} }

    @Module({ providers: [GlobalSvc] }) class ModG {}
    @Module({ imports: [ModG], providers: [Consumer] }) class ModC {}

    const app = await VelaFactory.create(ModC, { strict: true })
    expect(app.container.resolve(Consumer, 'ModC').g).toBeInstanceOf(GlobalSvc)
  })

  it('strict: false (default) preserves current behavior', async () => {
    @Injectable() class ServiceA {}
    @Injectable() class ServiceB { constructor(public a: ServiceA) {} }

    @Module({ providers: [ServiceA] }) class ModA {}
    @Module({ imports: [ModA], providers: [ServiceB] }) class ModB {}

    // Currently passes; should keep passing in non-strict mode for backward compatibility
    const app = await VelaFactory.create(ModB)
    expect(app.container.resolve(ServiceB, 'ModB').a).toBeInstanceOf(ServiceA)
  })

  it('detects collapsing of duplicate dynamic-module instances', async () => {
    // Audit #2: HttpModule.register({ A }) and HttpModule.register({ B }) must produce two distinct scopes
    @Module({}) class HttpModule {
      static register(opts: any): DynamicModule {
        return { module: HttpModule, providers: [{ provide: 'opts', useValue: opts }] }
      }
    }
    @Module({ imports: [HttpModule.register({ name: 'A' }), HttpModule.register({ name: 'B' })] })
    class App {}

    const app = await VelaFactory.create(App, { strict: true })
    // Both registrations should be addressable
    const all = app.container.resolveAll('opts', 'App')
    expect(all).toEqual(expect.arrayContaining([{ name: 'A' }, { name: 'B' }]))
  })
})
```

### Acceptance criteria

- [ ] `Container.resolve(token, moduleId)` accepts the requesting module id
- [ ] `VelaFactory.create(Mod, { strict: true })` enables enforcement
- [ ] `ModuleVisibilityError` is thrown with module + token + actionable message
- [ ] `@Global` tokens bypass enforcement
- [ ] Re-exports through transitive imports are honored
- [ ] Default (`strict: false`) preserves current behavior — no breakage
- [ ] Dynamic modules with different options register as distinct scopes
- [ ] All 39 existing tests pass with `strict: false`; new tests pass with `strict: true`
- [ ] CHANGELOG entry

**Effort estimate**: 3-5 days.

---

### 2. Bootstrap consolidation (audit #3)

**Problem**:

> `VelaFactory.create` and `TestingModuleBuilder.compile` re-implement app-token wiring; testing path doesn't register `ModuleRef` or consumer middleware.

**Why this is a blocker for erpos**:

erpos needs a **third bootstrap path** — the kernel CLI. Commands like `erpos migrate`, `erpos plugin:inspect`, `erpos custom-fields:promote` need to bootstrap the DI graph WITHOUT starting an HTTP server. If we copy vela's bootstrap into the kernel, the three implementations will drift over months. Bug "works in HTTP but not in CLI" becomes routine.

The right answer is to extract a single `bootstrap()` core function that all three call sites share.

### Sketch — `src/factory/bootstrap.ts` (NEW)

```ts
export interface BootstrapOptions {
  strict?: boolean
  mode: 'http' | 'test' | 'cli'
  overrides?: Map<InjectionToken, any>          // for testing
  diagnostics?: 'silent' | 'log' | 'throw'      // see audit #4, #6
}

export interface BootstrapResult {
  container: Container
  rootModuleId: string
  app?: Hono                                     // only when mode === 'http'
}

export async function bootstrap(rootModule: Type, options: BootstrapOptions): Promise<BootstrapResult> {
  const container = createContainer({ strict: options.strict ?? false })

  // 1. Walk module tree; register scopes
  const rootMeta = getModuleMetadata(rootModule)
  await runModuleLoader(rootMeta, container, options)

  // 2. Apply test overrides (testing only)
  if (options.overrides) {
    for (const [token, value] of options.overrides) {
      container.override(token, value)
    }
  }

  // 3. Wire global APP_* tokens (APP_GUARD, APP_PIPE, APP_INTERCEPTOR, APP_FILTER, APP_MIDDLEWARE)
  await wireGlobalAppTokens(container)

  // 4. Run lifecycle: OnModuleInit
  await runLifecycle(container, 'OnModuleInit', { diagnostics: options.diagnostics })

  // 5. Build Hono app (HTTP mode only)
  let app: Hono | undefined
  if (options.mode === 'http') {
    app = createHonoApp(container)
    await runRoutes(container, app)
  }

  return { container, rootModuleId: rootMeta.id ?? rootModule.name, app }
}
```

### Sketch — `src/factory.ts` (refactored)

```ts
export class VelaFactory {
  static async create(rootModule: Type, options: VelaFactoryOptions = {}): Promise<VelaApplication> {
    const result = await bootstrap(rootModule, { ...options, mode: 'http' })
    const application = new VelaApplication(result.container, result.app!)
    await runLifecycle(result.container, 'OnApplicationBootstrap', options)
    return application
  }
}
```

### Sketch — `src/testing/testing.builder.ts` (refactored)

```ts
export class TestingModuleBuilder {
  async compile(): Promise<TestingModule> {
    const result = await bootstrap(this.rootModule, {
      mode: 'test',
      overrides: this.overrideMap,
      strict: this.strict,
    })
    return new TestingModule(result.container, result.app)
  }
}
```

### Sketch — erpos CLI (downstream consumer)

```ts
// In @erpos/kernel/cli/bootstrap.ts (NOT in vela; lives in the kernel)
import { bootstrap } from '@velajs/vela/internal'

export async function bootstrapCli(): Promise<CliContext> {
  const { container } = await bootstrap(KernelModule, {
    mode: 'cli',
    strict: true,
    diagnostics: 'log',
  })
  return new CliContext(container)
}
```

### Tests — `src/__tests__/bootstrap-consolidation.test.ts`

```ts
describe('bootstrap()', () => {
  it('produces equivalent container in http and test modes', async () => {
    const rootMeta = getModuleMetadata(SomeModule)
    const httpResult = await bootstrap(SomeModule, { mode: 'http' })
    const testResult = await bootstrap(SomeModule, { mode: 'test' })
    // All providers from rootMeta should be resolvable in both
    for (const provider of rootMeta.providers) {
      const httpInstance = httpResult.container.resolve(provider)
      const testInstance = testResult.container.resolve(provider)
      expect(httpInstance.constructor).toBe(testInstance.constructor)
    }
  })

  it('cli mode does not create an HTTP app', async () => {
    const result = await bootstrap(SomeModule, { mode: 'cli' })
    expect(result.app).toBeUndefined()
  })

  it('VelaFactory.create still works', async () => {
    const app = await VelaFactory.create(SomeModule)
    expect(app.fetch).toBeDefined()
  })

  it('TestingModuleBuilder still works', async () => {
    const ref = await Test.createTestingModule({ rootModule: SomeModule }).compile()
    expect(ref.get(SomeService)).toBeInstanceOf(SomeService)
  })
})
```

### Acceptance criteria

- [ ] `src/factory/bootstrap.ts` exports `bootstrap()` taking `BootstrapOptions`
- [ ] `VelaFactory.create` calls `bootstrap({ mode: 'http' })`
- [ ] `TestingModuleBuilder.compile` calls `bootstrap({ mode: 'test' })`
- [ ] Both refactors are net code reduction (no logic duplicated)
- [ ] All existing tests pass without behavior change
- [ ] `bootstrap` exported from `@velajs/vela/internal` (no semver)
- [ ] CHANGELOG entry

**Effort estimate**: 2-3 days.

---

## Tier 2 — STRONGLY RECOMMENDED FOR THE SAME RELEASE

These can be hacked around in the erpos kernel, but doing so accumulates technical debt that's hard to unwind. Ideally they ship in vela 1.2.0 alongside the Tier-1 items.

### 3. Strict mode + structured discovery diagnostics (audit #4 + #6)

**Problem**:

> `NestModule.configure()` errors are swallowed.
> Silent discovery hides wiring problems — schedule, event-emitter, lifecycle discovery all `try/catch { /* skip */ }`.

**Impact for erpos**: silent failures in production. "Why didn't my subscriber fire?" becomes a black-box debugging session through vela source.

### Sketch — `BootstrapOptions.diagnostics`

```ts
type Diagnostics = 'silent' | 'log' | 'throw'

// In runLifecycle, runDiscovery, etc.:
async function runLifecycle(container: Container, hook: string, opts: { diagnostics?: Diagnostics }): Promise<void> {
  const diag = opts.diagnostics ?? 'log'
  for (const provider of container.allInstances()) {
    try {
      await provider[hook]?.()
    } catch (err) {
      const wrapped = new BootstrapError(`${hook} failed in ${tokenName(provider)}`, { cause: err })
      switch (diag) {
        case 'silent': break
        case 'log': container.logger.warn({ err: wrapped }, 'Lifecycle hook failed')
                     break
        case 'throw': throw wrapped
      }
    }
  }
}
```

Same pattern applied to: `MiddlewareConsumer.configure`, `ScheduleRegistry.discover`, `EventEmitter.discover`, `OnModuleInit/Destroy/etc.` discovery.

### Acceptance criteria

- [ ] `bootstrap({ diagnostics: 'log' | 'throw' | 'silent' })` controls behavior
- [ ] `'log'` is the default (current behavior is `'silent'`)
- [ ] All existing internal `try/catch { /* skip */ }` sites refactored to use the diagnostics dispatcher
- [ ] Tests for each behavior

**Effort estimate**: 2-3 days.

---

### 4. Workers vitest config (lock the edge claim)

**Problem**: vela's edge-runtime contract is enforced by **static scan only** (`src/__tests__/edge-runtime-audit.test.ts`). There's no live miniflare integration test.

**Impact for erpos**: erpos's primary deploy target is Cloudflare Workers. The static scan catches `node:fs` imports but doesn't catch subtler issues (e.g., a transitive dependency that pulls Node-only behavior at runtime, an `AsyncLocalStorage` use that misbehaves on Workers).

The fix is well-trodden: add `@cloudflare/vitest-pool-workers`.

### Sketch — `vitest.config.workers.ts`

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          compatibilityDate: '2026-04-30',
          compatibilityFlags: ['nodejs_compat'],
        },
      },
    },
    include: ['src/__tests__/workers/**/*.test.ts'],
  },
})
```

### Sketch — `wrangler.toml` (test-only)

```toml
name = "vela-edge-test"
main = "src/__tests__/workers/entry.ts"
compatibility_date = "2026-04-30"
compatibility_flags = ["nodejs_compat"]
```

### Sketch — `src/__tests__/workers/basic.test.ts`

```ts
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { VelaFactory } from '@velajs/vela'

describe('vela on Cloudflare Workers (live miniflare)', () => {
  it('boots and responds to a request', async () => {
    const response = await SELF.fetch('http://example.com/health')
    expect(response.status).toBe(200)
  })

  it('per-request DI scope works without AsyncLocalStorage', async () => {
    const r1 = await SELF.fetch('http://example.com/who-am-i', { headers: { 'x-user': 'alice' } })
    const r2 = await SELF.fetch('http://example.com/who-am-i', { headers: { 'x-user': 'bob' } })
    expect(await r1.text()).toBe('alice')
    expect(await r2.text()).toBe('bob')
  })

  it('handler chain (guard/pipe/interceptor/filter) executes in order', async () => {
    const response = await SELF.fetch('http://example.com/order-test')
    expect(await response.json()).toEqual({ order: ['guard', 'pipe', 'interceptor', 'handler', 'response-interceptor'] })
  })
})
```

### Acceptance criteria

- [ ] `vitest.config.workers.ts` added
- [ ] `wrangler.toml` for test purposes
- [ ] `src/__tests__/workers/` populated with smoke tests
- [ ] CI runs both `pnpm test` (existing Node tests) and `pnpm test:workers`
- [ ] Smoke test validates: boot, request lifecycle, per-request DI, handler chain order, OpenAPI mount

**Effort estimate**: 1-2 days.

---

### 5. Plugin manifest type + composer (NEW; can be added cleanly)

**Problem**: erpos's plugin system needs `definePlugin({ id, version, dependsOn, hooks: { onInstall, onTenantProvision } })` + a composer that takes `Plugin[]` and produces a `DynamicModule`. This logic could live entirely in `@erpos/kernel`, but a tiny generic version belongs in vela because:

- Other vela consumers may want plugin-style composition without erpos
- Vela already has `DynamicModule.forRoot/forRootAsync` — this is the next abstraction up
- It exercises the new module-visibility primitive in a natural way

### Sketch — `src/plugin/plugin.ts` (NEW)

```ts
export interface Plugin {
  id: string
  version: string
  module: Type | DynamicModule
  dependsOn?: string[]
  hooks?: {
    onInstall?: (ctx: PlatformContext) => Promise<void>
    onUninstall?: (ctx: PlatformContext) => Promise<void>
  }
  metadata?: Record<string, unknown>
}

export function definePlugin(opts: Plugin): Plugin {
  return Object.freeze(opts)
}

export function composePlugins(plugins: Plugin[]): DynamicModule {
  // Topological sort by dependsOn; reject cycles
  const sorted = topologicalSort(plugins)

  return {
    module: PluginRootModule,
    imports: sorted.map(p => isType(p.module) ? p.module : p.module),
    providers: [{ provide: PLUGIN_REGISTRY_TOKEN, useValue: new PluginRegistry(sorted) }],
    exports: [PLUGIN_REGISTRY_TOKEN],
  }
}

@Module({})
export class PluginRootModule {}
```

### Acceptance criteria

- [ ] `definePlugin`, `composePlugins`, `PluginRegistry`, `PLUGIN_REGISTRY_TOKEN` exported from `@velajs/vela`
- [ ] Topological sort + cycle detection
- [ ] `PluginRegistry.list()`, `PluginRegistry.get(id)`, `PluginRegistry.dependents(id)` queryable
- [ ] Tests for compose, cycle detection, missing-dep error
- [ ] Integration test: plugin A depends on plugin B; B is loaded first

**Effort estimate**: 2 days.

---

## Tier 3 — DEFER (not gating erpos kernel)

These are valid items in `CODE_AUDIT_REPORT.md` but don't block erpos. Land them on vela's normal maintenance cadence.

| Item | Audit # | Why we defer |
|---|---|---|
| `RouteManager` split (registration vs execution) | #9 | Internal hygiene; works as-is |
| Core types deduplication; remove `any` leaks | #5 | Code-quality cleanup |
| Compiler strictness raised | #10 | Safe to ship later |
| Edge-contract docs (explicit `schedule-node` carve-out) | #7 | Documentation; the test still enforces |
| `MetadataRegistry` + WeakMap fallback unification | #8 | Internal; works |
| Sanctioned `RequestContext` injectable (formalize child-container pattern) | (new) | The kernel can extract the pattern itself; promote to vela later |

These are perfectly worth doing, just not at the cost of slowing erpos. Track them as "vela 1.3+" work.

---

## Recommended sequencing

```
WEEK 1 (vela)
├── Day 1-3: Module visibility enforcement (Tier 1 #1)
├── Day 4-5: Bootstrap consolidation (Tier 1 #2)

WEEK 2 (vela)
├── Day 1-2: Strict mode + diagnostics (Tier 2 #3)
├── Day 3:   Plugin manifest type + composer (Tier 2 #5)
├── Day 4-5: Workers vitest config (Tier 2 #4)

End of week 2: vela 1.2.0 published.

WEEK 3+: erpos kernel P0 begins, consuming vela 1.2.0.
```

If the team doing vela work is one developer, this is two weeks of focused work. If parallelized, faster.

---

## Risk if we skip Tier 1

**Skipping module visibility**:
- Plugins can poke at any kernel internal
- Refactoring kernel internals breaks plugins silently
- "Marketplace" plans collapse because no plugin can be trusted in its sandbox
- **Recovery cost**: enormous — every shipped plugin needs auditing
- **Verdict**: cannot ship erpos without this

**Skipping bootstrap consolidation**:
- erpos kernel forks bootstrap logic into `@erpos/kernel/bootstrap`
- 6 months later, kernel-bootstrap and vela-bootstrap drift
- Bugs "work in HTTP but not in CLI" become routine
- **Recovery cost**: medium — re-converge later, but it's painful
- **Verdict**: ship erpos kernel anyway, accept the debt

**Skipping diagnostics + Workers vitest**:
- Production debugging is harder
- A future Cloudflare Workers regression slips past static scan
- **Recovery cost**: low — add later
- **Verdict**: not gating, but recommended for same release

---

## License + contribution

vela stays **MIT**. erpos depends on it as MIT (ELv2 freely consumes MIT). No CLA required for vela contributions.

When implementing the changes, the vela maintainer can land them directly. erpos consumers will pin `@velajs/vela ^1.2.0` once the release is cut.

---

## Cross-references

- erpos's coordinator doc: `docs/governance/upstream-roadmap.md` in the erpos repo
- erpos's vela dossier: `docs/refs/vela.md` in the erpos repo
- vela's audit: `CODE_AUDIT_REPORT.md` (this repo)
- vela's edge contract test: `src/__tests__/edge-runtime-audit.test.ts`
- Companion doc: `ERPOS_INTEGRATION.md` in `kshdotdev/hono-crud`

---

## Open questions

- **Should `definePlugin` move into vela, or stay in `@erpos/sdk`?** Current recommendation: a tiny generic version in vela; the erpos-specific shape (with `entities`, `events`, `agentTools`, etc.) wraps it in `@erpos/sdk`. This keeps vela reusable beyond erpos.
- ~~**Should strict mode default to `true` in vela 2.0?**~~ **Resolved**: vela 1.2.0 enforces module visibility unconditionally. NestJS-shape parity. No opt-out flag — `ModuleRef.create()` is the sandbox escape hatch when needed.
- **Should `bootstrap()` be in the public API or `@velajs/vela/internal`?** Public — it's the natural extension point for any consumer building a non-HTTP runtime.
