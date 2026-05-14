# vela ↔ erpos Integration — 1.6.0 Follow-up Spec

**Status:** Draft (resurrected post-1.5.x — original spec retired in commit `7f54252`)
**Date opened:** 2026-05-09
**Origin:** cross-repo audit at `erpos-ai/erpos/docs/governance/three-library-stack-audit.md`. Both prior gates (1.2.0 + 1.3 bonus work) are met; this spec covers the **two remaining items** that would let erpos's kernel retire its last vela-related workaround and one inline lazy-Proxy reimplementation.

## Why we're reopening the integration spec

Cross-repo audit on 2026-05-09 found that vela 1.5.x is unblocking everything erpos's P0/P1 needs, with one structural exception: **errors thrown inside Hono middlewares do not flow through `APP_FILTER`** (only `@Controller`-method handler errors do). erpos's kernel currently renders the canonical `ErpError` envelope inline via a `respondWithErpError` helper:

```ts
// packages/kernel/src/translators/_helpers/guards-from-acl.ts:48-60
function respondWithErpError(c: Context, err: ErpError): Response {
  return c.json(
    {
      error: {
        code: err.code,
        message: err.message,
        details: err.details ?? null,
        request_id: err.request_id,
      },
    },
    err.status as never,
  );
}
```

This is the **only** kernel-side workaround that traces back to vela. Closing it makes erpos's "no workarounds in kernel source" invariant CI-enforceable.

The second item is a **promotion**, not a fix: erpos's `@CurrentTenant()` parameter decorator returns a `Proxy` whose traps lazily resolve `TENANT_CONTEXT_TOKEN` the first time a property is read, with a `then`-trap escape so `await` doesn't trigger resolution. The pattern works around vela's argument-resolver running before guards (handler-executor order: extract-args → guards → handler), and is reusable by any vela consumer that needs guard-populated state in a `@Param`-style decorator.

## Items

### 1.6.0/A — `APP_FILTER` catches errors thrown inside Hono middlewares

**Today:** `RouteManager` registers middlewares onto Hono via `app.use(...)`/per-route attachment. When such a middleware throws, the exception propagates to Hono's outer error handler — vela's exception-filter chain (`APP_FILTER` + per-controller `@UseFilters`) does not see it. Per `velajs/vela/src/http/handler-executor.ts`, only handler-method errors enter the filter pipeline.

**Goal:** thrown errors inside any vela-attached middleware (global, module-level via `MiddlewareConsumer`, or per-route attached during translation) flow through the same filter chain a controller-thrown error takes. Filters render the `Response`; the chain short-circuits.

**Why this matters for erpos:** erpos generates synthetic CRUD endpoints whose ACL enforcement is implemented as Hono middlewares (because the synthetic controller has no source-level decorators to stamp `@RequireFeature` onto). Without this, every gated middleware must hand-render the SDK error envelope — duplication that doesn't compose with `@UseFilters` or future erpos-side filters.

**Implementation surface:**

- `src/http/route.manager.ts` — wrap the middleware functions registered on Hono so thrown errors are caught and re-routed through the filter chain.
- `src/pipeline/component-manager.ts` — confirm the filter resolution path is reachable from a non-handler context (or thread it through).
- `src/pipeline/types.ts` — no signature change; `ExceptionFilter.catch(exception, host)` already accepts an `ArgumentsHost` that can be synthesized from the Hono `Context`.

**Acceptance criteria:**

- New integration test `src/__tests__/middleware-error-flows-through-filter.test.ts`:
  - Register `APP_FILTER` that returns a known JSON body with a known status.
  - Register a module-level middleware via `MiddlewareConsumer.apply(...).forRoutes(...)` that throws a custom error.
  - Hit the route. Assert the response body matches the filter's output, not Hono's default 500.
- Same test parameterized for global middleware (`app.use`-equivalent) and per-route middleware attached via `RouteManagerOptions.globalMiddlewares`.
- Behavior is purely additive: middlewares that don't throw return `Response | void` exactly as before; `next()` semantics unchanged.
- `pnpm test:workers` green (live miniflare); the existing edge-runtime audit (`src/__tests__/edge-runtime-audit.test.ts`) still passes — no `node:*` introduced.

**Backwards compatibility:** purely additive. Existing consumers that catch errors inside their middlewares and render manually continue to work; the new behavior only triggers on uncaught errors that today reach Hono's outer handler.

**erpos cleanup gated on this:** `packages/kernel/src/translators/_helpers/guards-from-acl.ts` — delete `respondWithErpError` (lines 40-60), drop the doc comment block at lines 40-46, switch `featureMiddleware` to plain `throw new Forbidden(...)`. Keep the `RequestContext` lookup (`resolveRequestContextFromHono`) — that's the sanctioned `'container'` slot pattern, not a workaround.

### 1.6.0/B — `createLazyParamDecorator` helper

**Today:** vela's argument resolver runs before guards. Any parameter decorator that resolves a guard-populated DI token will fire its factory before the guard has populated state — yielding either undefined data or, worse, a misleading "TenantContext requested without an authenticated request"-style error from the provider's eager check.

erpos's workaround is a Proxy with then-trap escape (`packages/kernel/src/decorator-facades/current-tenant.ts:52-97`):

```ts
const target = Object.create(null) as object;
return new Proxy(target, {
  get(_t, prop) {
    if (prop === 'then') return undefined;  // not thenable — await must not trigger
    const real = resolve();                  // resolves on first property read
    const value = (real as unknown as Record<string | symbol, unknown>)[prop as string];
    return typeof value === 'function' ? (value as Function).bind(real) : value;
  },
  // ...has, ownKeys, getOwnPropertyDescriptor traps mirror real
}) as KernelTenantContext;
```

Every vela consumer with a similar shape needs this same pattern.

**Goal:** ship `createLazyParamDecorator((data, ctx: ExecutionContext) => T): ParameterDecorator` that produces the same Proxy structure, including the `then`-trap escape. Document **why**: vela's argument resolver runs before guards; this is the sanctioned way to consume guard-populated state in a parameter decorator.

**Implementation surface:**

- `src/http/lazy-param.decorator.ts` (new) — exports `createLazyParamDecorator`.
- `src/http/argument-resolver.ts` — no change (the Proxy is the resolved value; argument resolver doesn't need to know).
- `src/index.ts` and `src/internal.ts` — export `createLazyParamDecorator`.
- `README.md` — document the lifecycle ordering hazard + the helper as the canonical fix.

**Acceptance criteria:**

- Unit test in `src/__tests__/lazy-param-decorator.test.ts`:
  - Register a guard that populates a token in `REQUEST_CONTEXT`.
  - Register a `createLazyParamDecorator` that resolves the token.
  - Verify the factory **does not run** until the handler body actually reads a property of the returned value.
  - Verify `await value` returns the Proxy itself (not a thenable) and does not trigger resolution.
  - Verify `JSON.stringify(value)` works after one access.
- Document signature: returns a `ParameterDecorator` with the same DX as `createParamDecorator`.

**Backwards compatibility:** purely additive new export.

**erpos cleanup gated on this:** `packages/kernel/src/decorator-facades/current-tenant.ts` — delete the local Proxy implementation (lines 52-97), replace with `createLazyParamDecorator((_, ctx) => container.resolve(TENANT_CONTEXT_TOKEN))`. Same migration applies to any future lazy decorators erpos grows.

## Out of scope (tracked elsewhere or erpos-only)

- `RouteManager` further split (audit #9), type cleanup (audit #5/#10), metadata-store unification (already shipped), edge-contract docs (audit #7) — Tier 3 deferrals from the original 1.3+ list, untouched by this spec.
- The `'container'` slot lookup on Hono context (`request-context.bridge.ts:1-45`) — sanctioned vela pattern documented in CHANGELOG 1.2.0; not a workaround.
- erpos's SDK-shaped hook proxy in `hooks-from-entity.ts` — erpos product surface, not vela's concern.

## Acceptance gate for the release

- [ ] 1.6.0/A landed with passing integration test for global / module-level / per-route middleware error paths.
- [ ] 1.6.0/B landed with passing factory-deferral test.
- [ ] `pnpm test` and `pnpm test:workers` green.
- [ ] CHANGELOG entry for 1.6.0 documents both items + erpos retroactive cleanup links.
- [ ] erpos kernel CI (in a follow-up PR after the tag) bumps `@velajs/vela` to `^1.6.0`, deletes `respondWithErpError`, refactors `current-tenant.ts`, and adds the workaround invariants greps.

## See also

- `erpos-ai/erpos/docs/governance/three-library-stack-audit.md` — the full audit motivating this spec
- `erpos-ai/erpos/docs/governance/upstream-roadmap.md` — Tier-4 row for vela 1.6.0
- `kshdotdev/hono-crud/ERPOS_INTEGRATION.md` — the parallel hono-crud 0.10.0 spec
- `velajs/crud/ERPOS_INTEGRATION.md` — the velajs/crud 1.1.0 spec that forwards both new hono-crud features
