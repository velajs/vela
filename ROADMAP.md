# vela — Roadmap

This file tracks vela's own technical direction. Shipped work lives in `CHANGELOG.md`; this doc only covers what's planned next and which audit items remain.

## Next release (1.4)

### `REQUEST_CONTEXT` injectable

A sanctioned per-request primitive: stable `id`, `receivedAt`, the raw `Request`, the Hono `Context`, and a typed `set/get/has` bag for cross-cutting metadata (locale, feature flags, trace ids, …). Seeded by `RouteManager` into each per-request child container; resolves through `@Inject(REQUEST_CONTEXT)` from anywhere a request-scoped service can be reached. Honors an inbound `x-request-id` header; otherwise generates a UUID via Web Crypto. No `AsyncLocalStorage` — request scope is carried by the per-request child container, edge-runtime contract intact.

### Metadata stacking + funnel test coverage

Closes the test gap left over from audit #8. Asserts:
- `appendCustomHandlerMeta` is order-deterministic across many appends.
- `Reflect.defineMetadata` funnels into the typed `MetadataRegistry` slots (polyfill round-trip).
- `MetadataRegistry.reset()` clears `classMeta` and `handlerMeta`.
- Class-level + handler-level `@SetMetadata` on the same key remain independently addressable.

## Open audit follow-ups

From `CODE_AUDIT_REPORT.md`. These don't gate a specific release; pick them up on opportunistic cadence.

| # | Item | Why it's still open |
|---|---|---|
| 2 | Dynamic module identity is inconsistent | Some dynamic modules reuse their class; `HttpModule.register()` mints synthetic classes via `createModuleRef()`. Pick one identity model. |
| 9 | `RouteManager` is doing too much | Pipeline execution, argument extraction, and response shaping should be split out of route registration. Internal hygiene; works as-is. |

## Closed audit items

| # | Closed in | Notes |
|---|---|---|
| 1 | 1.3.0 | Module visibility enforced unconditionally via `ModuleVisibilityError`. |
| 3 | 1.3.0 | Bootstrap consolidated into `bootstrap(rootModule, options)`. |
| 4 | 1.1.0 (verified 1.4) | `NestModule.configure()` runs through `container.resolve(moduleClass, moduleId)`; failures propagate. Regression coverage in `configure-resolution.test.ts`. |
| 5 | 1.1.0 | `Type` / `Constructor` deduplicated to `container/types.ts`. |
| 6 | 1.3.0 | Discovery diagnostics route through `{ diagnostics: 'silent' \| 'log' \| 'throw' }`. |
| 7 | 1.4 | Edge-safe contract documented in README, including the explicit `schedule-node` carve-out and a link to the audit test. |
| 8 | 1.1.0 | Metadata is unified through `MetadataRegistry`; Reflect polyfill funnels into the same slots. 1.4 adds the regression tests. |
| 10 | 1.3.0 | Unused `Container.parent` removed. |
