# @velajs/crud — Integration Roadmap for erpos

This document tracks the changes `@velajs/crud` needs to support **erpos** (a pre-1.0, edge-portable ERP/CRM/marketing platform). erpos uses `@velajs/crud` as the kernel-internal **vela ↔ hono-crud bridge** — every entity declared via the erpos SDK's `defineEntity` translates into a `@velajs/crud` `CrudConfig` that gets registered through `CrudModule.forResource(...)` or via `@Crud()` on a synthetic controller.

erpos's full architecture lives in the erpos repo's `docs/`. This doc is self-contained for `@velajs/crud`; you don't need erpos context to act on it.

> **Pre-1.0 erpos posture**: erpos doesn't pursue backward compatibility yet (`docs/governance/backward-compatibility.md`). From `@velajs/crud`'s perspective this is a free pass — `0.x` versions can iterate naturally and erpos absorbs churn through its kernel translator.

---

## TL;DR

`@velajs/crud@0.3.0` already does the right thing: it owns the vela-side wiring (synthetic controllers, `@Crud`/`@Override` decorators, `ComponentManager` guard binding, OpenAPIHono sub-app mounting) and delegates the actual route generation to `hono-crud`. The kernel imports from `@velajs/crud` only; `hono-crud` is purely transitive.

**The gap**: `@velajs/crud` is intentionally narrow today. From `src/types.ts:13-14`:

> The CRUD operations surfaced by @velajs/crud. **Narrower than hono-crud's `CrudEndpointName` — extension to batch / search / aggregate / etc. is intentionally deferred.**

erpos's `defineEntity` has feature flags that map to operations beyond CRUD-5 (search, soft-delete restore, batch, versioning, custom fields). To avoid the kernel reaching around `@velajs/crud` to `hono-crud` directly (which would split the import path inconsistently), `@velajs/crud` needs to **expand to forward those operations** as `hono-crud` ships them.

This doc is the expansion roadmap.

> **Status (0.4.0):** Tier 1 endpoint widening shipped. `CrudEndpointName` now mirrors hono-crud's surface (search, aggregate, restore, batch ops, batchUpsert, export, import, upsert, clone). `defineCrudResource` ergonomic helper available. Versioning verbs remain deferred to 0.7+.

---

## What @velajs/crud already gives erpos (✅ unchanged, works today)

| Capability | Implementation |
|---|---|
| `@Crud(config)` class decorator | `crud.decorator.ts` |
| `@Override(endpoint)` method-level route override | `override.decorator.ts` |
| `CrudModule.forResource(path, config)` synthetic controller | `crud.module.ts` |
| `buildCrudRoutes(...)` — reads metadata, applies guards, mounts sub-app | `builder.ts` |
| Per-route hooks (flat `CrudHooks` sugar over hono-crud's per-endpoint hooks) | `types.ts:54-65` |
| Per-route DTO override (`CrudDtos.create` / `.update` → hono-crud's `bodySchema`) | `types.ts:44-47` |
| Vela guard integration (controller-level + per-endpoint) | `builder.ts` + `ComponentManager` |
| `EndpointOverride<M>` per-endpoint hono-crud config pass-through | `types.ts:29-35` |

The CRUD-5 path is solid and erpos's first business modules can ship against it as-is.

---

## What @velajs/crud needs (the expansion)

### Tier 1 — drives the kernel's reference module + first business modules

#### 1. Widen `CrudEndpointName` to cover hono-crud's surface

```ts
// src/types.ts (extension)
export type CrudEndpointName =
  | 'create' | 'list' | 'read' | 'update' | 'delete'
  // NEW (Tier 1):
  | 'search' | 'aggregate' | 'restore'
  | 'batchCreate' | 'batchUpdate' | 'batchDelete' | 'batchRestore' | 'batchUpsert'
  | 'export' | 'import'
  | 'upsert' | 'clone'
  // NEW (Tier 2 — versioning):
  | 'versionHistory' | 'versionRead' | 'versionCompare' | 'versionRollback'

export const ALL_CRUD_ENDPOINTS: readonly CrudEndpointName[] = [...]   // updated
```

`EndpointOverride<M>` widens correspondingly — each new key forwards to the matching `EndpointsConfig<M>` slot in hono-crud.

`CrudConfig.endpoints` becomes:

```ts
endpoints?: { [K in CrudEndpointName]?: EndpointOverride<M>[K] }
```

`only` / `except` filters apply to all of them.

**Acceptance criteria**:
- A `@Crud({ meta, adapters, only: ['list', 'search', 'restore'] })` controller registers exactly those three routes
- `@Override('search')` works on the same controller
- `EndpointOverride.search` accepts hono-crud's full `SearchEndpoint` config
- `buildCrudRoutes` route-validation rejects unknown endpoint names with a clear error
- Tests cover each new endpoint name end-to-end via memory adapter

**Effort estimate**: 2-3 days (mostly type widening + test coverage; the route-generation work is already in hono-crud).

#### 2. Forward `Model.resolveSchema` (depends on hono-crud 0.6.0)

When hono-crud lands the `Model.resolveSchema` hook for per-tenant runtime schema resolution, `@velajs/crud` exposes it through `CrudConfig.meta`:

```ts
// types.ts — no shape change; meta passes through verbatim
config.meta = defineMeta({ model: defineModel({
  ..., 
  resolveSchema: async ({ tenantId, request }) => mergedSchemaFor(tenantId),
})})
```

`buildCrudRoutes` already calls `defineEndpoints(endpointsDef, crudConfig.adapters)` which forwards `meta` → hono-crud's `Model`. **No code change in @velajs/crud is required** once hono-crud lands the field — it pass-throughs naturally.

What **does** need a small change: if `@velajs/crud` adds Tier-1 ergonomic helpers (see §3 below) that accept a `model` instead of a pre-built `meta`, those helpers need to forward `resolveSchema` correctly.

**Acceptance criteria**:
- A test creates a `Model` with `resolveSchema`, registers via `@Crud`, and asserts that POST/GET requests with different tenant headers see different validated bodies + different OpenAPI schemas
- Required for erpos kernel P1 (custom fields end-to-end)

**Effort estimate**: 1 day (mostly the integration test).

#### 3. (Optional) `defineCrudResource` ergonomic helper

A vela-flavored builder that bundles `@Controller` + `@Crud` + override blocks for plugin authors who want to skip the synthetic-controller pattern:

```ts
import { defineCrudResource } from '@velajs/crud'

export const UserResource = defineCrudResource({
  path: '/users',
  meta: userMeta,
  adapters: MemoryAdapters,
  only: ['list', 'read', 'create', 'update'],
  guards: [AuthGuard, AdminOnlyGuard],
  hooks: {
    beforeCreate: (data) => ({ ...data, createdBy: 'system' }),
  },
  overrides: {
    list: async (c) => c.json({ result: customListImpl() }),
  },
})

// In a vela module:
@Module({ imports: [UserResource] }) class UsersModule {}
```

Internally this is a wrapper around `CrudModule.forResource(...)` — same registration, friendlier API surface. Optional; the existing `@Crud` decorator stays as the explicit alternative.

**Acceptance criteria**:
- `defineCrudResource(...)` returns a `DynamicModule` that registers identically to `CrudModule.forResource(...)`
- Override functions registered through the helper behave identically to `@Override`-decorated methods
- Tests cover both paths producing equivalent route trees

**Effort estimate**: 1-2 days.

---

### Tier 2 — drives kernel HIL + policy enforcement (depends on hono-crud 0.7.0)

#### 4. Forward `requireApproval` guard (HIL deferred execution)

When hono-crud lands `requireApproval` (its 0.7.0 Tier-2 spec), `@velajs/crud` exposes it as a per-endpoint middleware:

```ts
// In CrudConfig — no shape change; existing `endpoints.{name}.middlewares` works
@Crud({
  meta: invoiceMeta,
  adapters: DrizzleAdapters,
  endpoints: {
    delete: {
      middlewares: [requireApproval({ reason: 'Permanent invoice deletion', expiresAfter: 'P1D' })],
    },
  },
})
```

Already supported transparently — `@velajs/crud` forwards `endpoint.middlewares` to hono-crud's `endpointMiddlewares`. **Verify with an integration test** once hono-crud ships the guard.

#### 5. Forward `requirePolicy` guard + `Model.policies` (row/field-level rules)

Same shape — `Model.policies` lives on the model passed via `meta`; the `requirePolicy` guard plugs into per-endpoint middlewares. No shape change in `@velajs/crud`. Verify with integration test.

#### 6. `tenantId` + `organizationId` + actor identity in `CrudEventPayload`

Pure transitive pass-through — `CrudEventEmitter` is owned by hono-crud; `@velajs/crud` doesn't intercept events. When hono-crud's payload widens, downstream `CrudEventEmitter.on(...)` listeners see the new fields. No code change in `@velajs/crud`.

#### 7. Transactional hooks (`hooks.afterCreate` etc. inside parent tx)

When hono-crud lands the `HookContext` change (its 0.7.0 G2 spec), `@velajs/crud`'s `CrudHooks` flat sugar needs to **forward the new context shape**:

```ts
// types.ts (modified)
export interface CrudHooks {
  beforeCreate?: (ctx: HookContext, data: unknown) => unknown | Promise<unknown>   // was (data) => ...
  afterCreate?:  (ctx: HookContext, data: unknown) => unknown | Promise<unknown>
  beforeList?:   (ctx: HookContext) => void | Promise<void>
  afterList?:    (ctx: HookContext, items: unknown[]) => unknown[] | Promise<unknown[]>
  beforeRead?:   (ctx: HookContext, lookupValue: string) => void | Promise<void>
  afterRead?:    (ctx: HookContext, data: unknown) => unknown | Promise<unknown>
  beforeUpdate?: (ctx: HookContext, data: unknown) => unknown | Promise<unknown>
  afterUpdate?:  (ctx: HookContext, data: unknown) => unknown | Promise<unknown>
  beforeDelete?: (ctx: HookContext, lookupValue: string) => void | Promise<void>
  afterDelete?:  (ctx: HookContext, lookupValue: string) => void | Promise<void>
}
```

`buildCrudRoutes` already forwards flat hooks to per-endpoint hooks via `endpoints.{name}.hooks.{before,after}` — the signature change propagates automatically. Update the wrapper to thread `ctx` through. **Tier 2** — required for erpos's event-outbox pattern at kernel P1.

**Acceptance criteria**:
- A flat `afterCreate` receives a `HookContext` whose `db.tx` is the same tx as the parent INSERT
- A flat `afterCreate` that throws causes the parent write to roll back
- Memory adapter: hooks receive a no-op `db.tx` proxy
- Drizzle adapter: real `db.transaction` handle

**Effort estimate**: 1-2 days (signature change + integration tests with memory + Drizzle adapters).

---

### Tier 3 — defer

| Item | Why we defer |
|---|---|
| `MCP descriptor emitter` (walk OpenAPI → MCP tool catalog) | Lives in `@erpos/ai-runtime`; only land here if non-erpos vela consumers want it |
| Cache mixins exposed via `CrudConfig` | Use hono-crud's `withCache` / `withCacheInvalidation` mixins directly via `EndpointOverride.{name}` for now |
| Rate-limit middleware sugar | Existing per-endpoint middleware path covers it |
| Idempotency middleware sugar | Same |
| API versioning sugar | Same — `EndpointOverride` already accepts middlewares |

---

## Sequencing

```
0.4 — ✅ shipped — Tier 1 #1: widen CrudEndpointName + EndpointOverride. Tier 1 #3: defineCrudResource ergonomic helper.

0.5 — ✅ shipped — Tier 1 #2: integration test for Model.resolveSchema pass-through.

0.6 — Tier 2 #4 + #5 + #6: requireApproval, requirePolicy, event-payload tenant/actor pass-through verification (~2 days)
      Tier 2 #7: transactional hooks signature change with HookContext threading (~1-2 days)
      → published once hono-crud 0.7.0 lands

0.7+ — Tier 1 #1 cont: versioning endpoints (versionHistory/Read/Compare/Rollback) once a real consumer exercises them
       Tier 3 considered as opportunistic improvements
```

Total Tier 1 + 2 effort: ~7-10 days spread across three minor releases. None of it gates erpos kernel P0; #1 (endpoint widening) gates kernel P1 since the reference module needs `search` + `restore`.

---

## Risk if expansion lags

**If endpoint widening (#1) doesn't ship before erpos kernel P1**:
- The kernel's `entity.translator.ts` has to reach around `@velajs/crud` to `hono-crud` directly for search/restore/batch/etc. — splits the import path
- TODO comments mark the reach-arounds; replace once `@velajs/crud` widens
- Layered architecture is muddied but not broken; recoverable

**If transactional hooks (#7) don't ship before erpos kernel P1**:
- Event-outbox pattern can't use `@velajs/crud`'s flat `CrudHooks` — kernel writes outbox rows via separate Drizzle middleware around the entity routes
- More plumbing in the kernel; recoverable when #7 lands

**If `requireApproval`/`requirePolicy` don't ship before erpos kernel P2**:
- HIL goes through kernel-side hono middleware that intercepts before `@velajs/crud`'s sub-app
- Policy enforcement happens kernel-side post-fetch
- Recoverable but performance-suboptimal until upstream guards land

None of these are existential. The recovery path is documented; the expansion just makes the kernel cleaner.

---

## Cross-references

- erpos's coordinator doc: `docs/governance/upstream-roadmap.md` in the erpos repo
- erpos's velajs/crud dossier: `docs/refs/velajs-crud.md` in the erpos repo (NEW)
- erpos kernel internals: `docs/architecture/kernel-internals.md` in the erpos repo
- Companion specs: `ERPOS_INTEGRATION.md` in `velajs/vela` and `kshdotdev/hono-crud`

---

## License + contribution

`@velajs/crud` stays **MIT** (matches `@velajs/vela` and `hono-crud`). erpos depends on it as MIT-from-source-available. No CLA required.

---

## Open questions

- **Should `defineCrudResource` (Tier 1 #3) be required or optional?** Recommendation: optional. The existing `@Crud` decorator on user-written classes stays as the explicit form; `defineCrudResource` is sugar for the common case
- **Should `@velajs/crud` expose a `defineEntity`-like primitive that mirrors erpos's SDK shape?** No — that's erpos's job. `@velajs/crud` stays vela/hono-crud-flavored; the SDK shape is built on top in the erpos kernel
- **Should the tier ranking change as hono-crud's roadmap shifts?** Yes — re-evaluate this doc whenever `kshdotdev/hono-crud/ERPOS_INTEGRATION.md` updates
