# Vela Code Audit Report

Date: 2026-04-30

## Scope

This audit reviewed the TypeScript source under `src/`, focusing on code smells, architecture drift, type safety, edge-runtime compatibility, duplication, and whether the framework is wired into a coherent model.

## Verification

- `pnpm run typecheck` passes.
- `pnpm test` passes: 39 test files, 646 tests.
- `pnpm exec tsc --noEmit --noUnusedLocals --noUnusedParameters` reports one issue:
  - `src/container/container.ts`: unused private field `parent`.

## Executive Summary

The project is in a good baseline state from a compiler and test perspective. The main risks are architectural rather than immediate test failures:

- Module imports and exports are represented, but not enforced as real provider visibility boundaries.
- The container auto-registers unresolved classes, which hides wiring mistakes.
- Production and testing bootstrap logic duplicate the same app-token wiring and already drift.
- Dynamic module identity is inconsistent across modules.
- Several discovery paths swallow errors and continue silently.
- Type definitions are duplicated across framework layers, with public `any` escape hatches leaking into the model.

The codebase would benefit from consolidating around a stricter module graph and explicit provider-resolution model.

## Findings

### 1. Module Boundaries Are Not Enforced

Severity: High

Relevant files:

- `src/module/module-loader.ts`
- `src/container/container.ts`

`ModuleLoader` processes module imports and exports, but all providers are ultimately registered into a single root container. Separately, `Container.resolve()` auto-registers any unresolved class token.

This means a service can resolve even when its declaring module did not import the module that exports the dependency. As a result, `imports` and `exports` mostly act as metadata and warning inputs, not actual dependency boundaries.

Recommended direction:

- Build an explicit module graph during loading.
- Track each module's local providers, imported exports, and global exports.
- Resolve constructor dependencies against the requesting module context.
- Remove normal-path class auto-registration from `Container.resolve()`.
- Keep explicit auto-registration only where the framework intentionally bootstraps controllers or built-ins.

### 2. Dynamic Module Identity Is Inconsistent

Severity: High

Relevant files:

- `src/module/module-loader.ts`
- `src/cache/cache.module.ts`
- `src/config/config.module.ts`
- `src/fetch/fetch.module.ts`

Dynamic modules are cached by module class. Some modules reuse their real class, while `HttpModule.register()` creates synthetic module references through `createModuleRef()`.

This creates two competing models:

- Dynamic module options are sometimes attached to a normal module class.
- Dynamic module imports sometimes rely on synthetic throwaway classes.

Because `ModuleLoader` treats a processed module class as complete, repeated dynamic imports with different options can be skipped or collapsed unintentionally.

Recommended direction:

- Introduce an internal `ModuleInstance` or `ModuleToken` concept.
- Derive identity from module class plus dynamic metadata where appropriate.
- Make all dynamic modules follow the same pattern.
- Avoid ad hoc synthetic classes as the primary identity mechanism.

### 3. Bootstrap Logic Is Duplicated And Drifting

Severity: High

Relevant files:

- `src/factory.ts`
- `src/testing/testing.builder.ts`

`VelaFactory.create()` and `TestingModuleBuilder.compile()` both manually wire `APP_GUARD`, `APP_PIPE`, `APP_INTERCEPTOR`, `APP_FILTER`, and `APP_MIDDLEWARE`.

The testing bootstrap already differs from production:

- Production registers `ModuleRef`; testing does not.
- Production registers consumer middleware from `ModuleLoader`; testing does not.
- Both files duplicate app-token resolution logic.

Recommended direction:

- Extract a shared bootstrap function that creates the container, route manager, module loader, app providers, lifecycle hooks, and routes.
- Let production and testing pass different options into the same bootstrap path.
- Add tests that prove testing modules support the same app-token and middleware behavior as production.

### 4. `NestModule.configure()` Is Silently Skipped

Severity: Medium

Relevant file:

- `src/module/module-loader.ts`

`ModuleLoader` calls `new moduleClass()` directly to run `configure()`. If the module has constructor dependencies, the error is swallowed and middleware configuration is skipped.

That is a workaround. A module that cannot be instantiated correctly should not fail quietly, because it creates a partially wired application.

Recommended direction:

- Register module classes as providers or instantiate them through the container.
- If constructor injection for modules is unsupported, fail with a clear error.
- Do not swallow `configure()` failures unless there is a deliberate non-strict mode with diagnostics.

### 5. Core Types Are Duplicated And Loose

Severity: Medium

Relevant files:

- `src/container/types.ts`
- `src/registry/types.ts`
- `src/module/types.ts`

`Type<T = any>` is defined in multiple files. `Constructor` is modeled as `Function`, and provider factories use `any[]`.

Some constructor signatures may need a narrow internal escape hatch, but the public framework model should not repeat `any` across layers.

Recommended direction:

- Define `ClassType<T = unknown>` or equivalent once.
- Re-export it from the modules that need it.
- Prefer `abstract new (...args: never[]) => T` or `new (...args: unknown[]) => T` where possible.
- Keep unavoidable constructor `any` in one internal type alias with a comment explaining why.
- Type provider factories with tuple generics over `inject` when practical.

### 6. Silent Discovery Hides Wiring Problems

Severity: Medium

Relevant files:

- `src/module/module-loader.ts`
- `src/schedule/schedule.registry.ts`
- `src/event-emitter/event-emitter.subscriber.ts`
- `src/schedule-node/schedule.executor.ts`

Several discovery paths catch errors and continue:

- Lifecycle instance discovery skips unresolvable providers/controllers.
- Schedule discovery skips unresolvable scheduled providers.
- Event subscriber discovery skips unresolvable subscribers.
- Schedule executor swallows job errors.

This keeps the framework running, but makes broken wiring hard to detect.

Recommended direction:

- Add structured diagnostics for skipped providers and subscribers.
- Fail during bootstrap for framework wiring errors.
- Keep runtime job error isolation for scheduler jobs, but route errors through a logger or hook.
- Consider a strict mode default for application bootstrap.

### 7. Edge Runtime Contract Has A Sub-Export Exception

Severity: Medium

Relevant files:

- `src/schedule-node/schedule.executor.ts`
- `src/__tests__/edge-runtime-audit.test.ts`
- `package.json`

The `schedule-node` sub-export intentionally uses `setInterval`, and the edge-runtime audit excludes `src/schedule-node`.

This is coherent if the package contract is:

> The main export is edge-safe; `@velajs/vela/schedule-node` is an opt-in Node/Bun adapter.

It conflicts with a stricter interpretation that all framework source must avoid runtime-specific APIs.

Recommended direction:

- Document the contract explicitly in README and package export docs.
- Consider moving Node/Bun adapters to a separate package if the project wants all source under this package to satisfy edge-runtime rules.
- Keep edge CI checking the main export and all non-opt-in source paths.

### 8. Metadata Is Split Across Two Stores

Severity: Medium

Relevant files:

- `src/metadata.ts`
- `src/registry/metadata.registry.ts`
- `src/http/decorators.ts`
- `src/pipeline/reflector.ts`

The project uses both `MetadataRegistry` and a WeakMap-based metadata polyfill. Decorators often write to both stores for compatibility, while readers check registry first and then the WeakMap.

This works, but it increases drift risk because every new decorator must remember which store to write and which store to read.

Recommended direction:

- Define one metadata access abstraction.
- Keep compatibility fallback inside that abstraction, not repeated across decorators and readers.
- Make tests assert that each metadata feature survives `MetadataRegistry.clear()` only when that behavior is intentional.

### 9. RouteManager Is Doing Too Much

Severity: Medium

Relevant file:

- `src/http/route.manager.ts`

`RouteManager` currently handles route registration, middleware sorting, middleware execution, parameter extraction, pipe execution, guard execution, interceptor execution, filter handling, response creation, versioned paths, and CRUD integration.

This makes route behavior centralized, but the class is becoming a framework runtime kernel rather than a route manager.

Recommended direction:

- Extract request pipeline execution into a `RequestPipeline` or `HandlerExecutor`.
- Extract argument extraction into an `ArgumentResolver`.
- Extract response mapping into a `ResponseMapper`.
- Keep `RouteManager` focused on Hono route registration and path composition.

### 10. Compiler Strictness Can Be Raised

Severity: Low

Relevant files:

- `tsconfig.json`
- `src/container/container.ts`

Strict mode is enabled, but unused locals and parameters are not enforced. Running TypeScript with `--noUnusedLocals --noUnusedParameters` catches an unused `parent` field in `Container`.

Recommended direction:

- Enable `noUnusedLocals`.
- Enable `noUnusedParameters` if decorator signatures and framework interface implementations can be kept clean.
- Remove `Container.parent` if no planned parent lookup behavior exists.

## Refactor Priority

1. Define and enforce the module/provider visibility model.
2. Remove normal-path auto-registration from `Container.resolve()`.
3. Extract shared application bootstrap logic.
4. Normalize dynamic module identity.
5. Centralize core framework types and reduce public `any`.
6. Replace silent discovery catches with diagnostics or strict failures.
7. Decide and document the edge-runtime contract for opt-in runtime adapters.
8. Consolidate metadata access behind one abstraction.
9. Split `RouteManager` responsibilities after the module/container model is stable.
10. Enable unused-code compiler checks.

## Suggested First Implementation Slice

A safe first slice is to extract shared bootstrap logic without changing provider semantics:

- Create an internal bootstrap helper used by both `VelaFactory.create()` and `TestingModuleBuilder.compile()`.
- Move app-token wiring into one data-driven loop.
- Register `ModuleRef` consistently.
- Register consumer middleware consistently.
- Preserve current tests.

This removes duplication and makes later module/container tightening less risky.
