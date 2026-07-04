# velajs/crud ↔ erpos Integration — 1.1.0 Follow-up Spec

**Status:** Draft (resurrected post-1.0.0 — original spec retired in commit `50924df`)
**Date opened:** 2026-05-09
**Origin:** cross-repo audit at `erpos-ai/erpos/docs/governance/three-library-stack-audit.md`. velajs/crud 1.0.0 stabilized the bridge and erpos's kernel pins `^1.0`. This spec covers **three items** for 1.1.0 — one new fail-fast invariant for tenant-scoped entities + two pass-throughs that forward hono-crud 0.10.0's new features.

## Why we're reopening the integration spec

Cross-repo audit on 2026-05-09 found that velajs/crud 1.0.0's "parent-app middleware" pattern for `requireApproval`/`requirePolicy`/`multiTenant` is correct, but **silently degrades** when a misconfigured plugin author mounts a tenant-scoped `CrudModule.forResource` without wiring `multiTenant()` middleware on the parent Hono app. The result: `tenantId` is `undefined` in `HookContext` and in `CrudEventPayload`, and audit/event writes lose tenant attribution. The kernel translator wires it correctly today, but a third-party plugin author has no visible signal that the wiring is required.

The other two items are pass-throughs — once hono-crud 0.10.0 ships `prior` state and configurable `responseEnvelope`, velajs/crud's flat-sugar layer needs to forward both so erpos's translator sees them through the bridge.

## Items

### 1.1.0/A — `MissingTenantResolverError` on misconfigured `CrudModule.forResource`

**Today:** `CrudModule.forResource(mountPath, config)` accepts a `Model` whose `multiTenant: true | MultiTenantConfig` (or `policies.readPushdown` derived from tenant scope) declares the resource is tenant-scoped, but does not assert that the parent Hono app actually has a tenant resolver mounted. The bridge silently passes `tenantId: undefined` when the resolver is missing.

**Goal:** at module-load time, when the resolved `Model` declares tenant scope, assert one of:

- The parent app has a `multiTenant()` middleware mounted upstream of the CRUD sub-app, **or**
- The translator caller passes an explicit `tenantResolverMounted: true` flag on the bridge config (escape hatch for synthetic test apps).

If neither is true, throw a typed `MissingTenantResolverError` with a message that quotes the velajs/crud `[0.6.0]` CHANGELOG note about parent-app middleware, plus the entity name and mount path.

**Detection strategy** (proposal — final shape decided in implementation):

- The bridge's `forResource` builder runs a one-time smoke check at the first request (or at module init if it can be done without a request) that asks `c.var.tenantId` on a probe handler. If `multiTenant()` populated it (even with a sentinel), proceed; otherwise throw.
- Cheaper alternative: the bridge inspects the parent app's middleware stack at mount time. Hono exposes registered middleware via `app.routes` / internal accessors — viable if the API is stable.
- Simplest alternative: require the caller to pass `tenantResolverMounted: true` in `RegisterCrudOptions`-equivalent. erpos's translator will pass it. Third-party plugin authors get a typed compile error if they forget. **This is probably the right shape** — explicit, no runtime introspection.

**Why this matters for erpos:** erpos's kernel translator already wires `multiTenant()` correctly (per `docs/governance/upstream-roadmap.md:201`). But the kernel exists to translate SDK declarations into library calls; if a future SDK refactor or a third-party plugin author's use of `CrudModule.forResource` outside the kernel's translator skips the wiring, today's silent failure becomes a silent data-loss bug. The fail-fast assertion makes this class of misconfiguration impossible to ship.

**Implementation surface:**

- `src/builder.ts` (or wherever `CrudModule.forResource` lives) — add the assertion.
- `src/types.ts` — add `MissingTenantResolverError` typed exception + `tenantResolverMounted?: boolean` config field.
- `CHANGELOG.md` — document the new error, with the migration note (set `tenantResolverMounted: true` if your parent app wires `multiTenant()` outside the standard pattern).

**Acceptance criteria:**

- New test in `tests/missing-tenant-resolver.test.ts`:
  - Mount a tenant-scoped `CrudModule.forResource` on a Hono app **without** `multiTenant()`. Assert `MissingTenantResolverError` is thrown at bootstrap (or at first request — whichever the chosen detection strategy supports).
  - Mount the same with `multiTenant()` upstream → no throw.
  - Mount the same with `tenantResolverMounted: true` and no `multiTenant()` → no throw (escape hatch).
- `examples/` updated with a "tenant-scoped resource" example demonstrating the canonical wiring.

**Backwards compatibility:** **soft breaking** for any consumer that mounts tenant-scoped resources without `multiTenant()` and was tolerating the silent `tenantId: undefined`. Such consumers are buggy by definition; the breakage is desired. Bump minor under 1.x.

### 1.1.0/B — Forward hono-crud's `prior` arg through `mergeFlatHooks`

**Today:** velajs/crud's flat-sugar `CrudHooks` shape is `{ beforeCreate, afterCreate, beforeUpdate, afterUpdate, beforeDelete, afterDelete }` with `(ctx: HookContext, data) => ...` per hook (locked in 0.6.0). hono-crud 0.10.0 will change `afterUpdate`/`afterDelete` to `(prior, current, ctx)` / `(prior, ctx)`.

**Goal:** velajs/crud's flat-sugar shape becomes `(ctx, prior, current) => ...` for `afterUpdate` and `(ctx, prior) => ...` for `afterDelete`. The bridge in `mergeFlatHooks` flips arg order and forwards both `prior` and `current` through.

**Implementation surface:**

- `src/builder.ts` (`mergeFlatHooks`) — update the shape for `afterUpdate` / `afterDelete`.
- `src/types.ts` — update `CrudHooks` signatures.
- `CHANGELOG.md` — document the breaking signature change with a migration snippet.

**Acceptance criteria:**

- Test in `tests/hooks-arg-order.test.ts` (or equivalent) asserts the flat sugar receives `(ctx, prior, current)` for updates and `(ctx, prior)` for deletes.
- All existing flat-sugar tests updated to the new signature.
- `examples/` updated.

**Backwards compatibility:** breaking — bump minor under 1.x. Migration is mechanical: `(ctx, data) => ...` becomes `(ctx, prior, current) => ...` (use `prior` if you previously needed pre-state; use `current` otherwise).

**erpos cleanup gated on this:** `packages/kernel/src/translators/_helpers/hooks-from-entity.ts` — at lines 91-99 and 109-117, the `data as never, data as never` duplicate pass becomes `(prior, current)` actually flowing from upstream. The fix is one velajs/crud upgrade away once hono-crud 0.10.0 ships.

### 1.1.0/C — Forward hono-crud's `responseEnvelope` through `CrudConfig`

**Today:** `CrudConfig` exposes `endpoints`, `middlewares`, `policies`, etc., but not `responseEnvelope`. Consumers can't customize the success/error envelope through the bridge.

**Goal:** add `responseEnvelope?: { success: (result, info?) => unknown; error: (err) => unknown }` to `CrudConfig`. The bridge forwards it verbatim into the underlying `RegisterCrudOptions` when calling `registerCrud`.

**Implementation surface:**

- `src/types.ts` — extend `CrudConfig` (and `ResourceConfig` if separate).
- Wherever `registerCrud` is invoked from the bridge — thread the option through.

**Acceptance criteria:**

- Test asserts a custom envelope passed through `CrudConfig.responseEnvelope` reaches the rendered response.
- Default behavior unchanged when omitted.

**Backwards compatibility:** purely additive. No migration needed.

**erpos integration gated on this:** `packages/kernel/src/translators/entity.translator.ts` — pass the `ErpError`-shaped envelope through `CrudModule.forResource(mountPath, { responseEnvelope, ... })`. Combined with vela 1.6.0/A's `APP_FILTER` widening, this gives erpos one canonical envelope across success + error paths on every generated CRUD endpoint.

## Out of scope (tracked elsewhere)

- Versioning endpoints, cache/rate-limit/idempotency/api-version sugar, MCP descriptor emitter — Tier 3 from the original tracking table; untouched by this spec.

## Acceptance gate for the release

- [ ] 1.1.0/A landed with passing fail-fast tests + escape-hatch documented.
- [ ] 1.1.0/B landed with passing arg-order tests; CHANGELOG migration snippet for downstream consumers.
- [ ] 1.1.0/C landed with passing forward test.
- [ ] `pnpm test` green.
- [ ] CHANGELOG entry documents all three items + the breaking after-hook signature change.
- [ ] hono-crud 0.10.0 must be tagged before this release so the bridge can pin to it.

## Sequencing relative to upstream

```
hono-crud 0.10.0 (prior + responseEnvelope) — must ship first
        v
velajs/crud 1.1.0 — depends on hono-crud 0.10.0
        v
erpos kernel cleanup commit 4.B — bumps both
```

vela 1.6.0 (`APP_FILTER` widening + `createLazyParamDecorator`) is independent and can ship in parallel with hono-crud 0.10.0; erpos kernel cleanup commits 4.A (vela), 4.B (hono-crud + velajs/crud), and 4.C (lazy-decorator refactor) sequence after their respective upstream tags.

## See also

- `erpos-ai/erpos/docs/governance/three-library-stack-audit.md` — the full audit motivating this spec
- `erpos-ai/erpos/docs/governance/upstream-roadmap.md` — Tier-4 rows for velajs/crud 1.1.0
- `kshdotdev/hono-crud/ERPOS_INTEGRATION.md` — hono-crud 0.10.0 spec (prior-state + envelope)
- `velajs/vela/ERPOS_INTEGRATION.md` — vela 1.6.0 spec (`APP_FILTER` widening, prerequisite for envelope unification)
