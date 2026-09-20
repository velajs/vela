# Changelog

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/vela@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/vela@2.0.1

## 2.0.0

Typed override descriptors and production-equivalent request and environment scope.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.0.0

### Major Changes

- 02bb42e: Target the published Vela 1.21 security release and use Vela's production bootstrap primitive so request context, global providers, and request-scoped test execution cannot drift from the real runtime. Standalone CI no longer relies on a sibling `link:../vela` checkout.

## 0.6.0

### Minor Changes

- 5097ee4: Add `@velajs/testing/eval`: a small, model-agnostic harness for scoring the output of any string-producing function. Ships heuristic scorers (`exactMatch`, `contains`, `keyword`, `regex`), an `llmScorer` LLM-as-judge whose `judge` callback is injected (no AI SDK dependency, fails soft on unparseable replies), and `evaluate(dataset, run, scorers)` which returns per-case reports plus a per-scorer and overall aggregate.

## 0.5.1

### Patch Changes

- 647fd5f: Modernize the package build, validation, and release toolchain.

## 0.3.0 (2026-07-04)

- `ComponentManager.init` call removed; provider overrides use the supported `Container.replaceProvider`; registers `DiscoveryService` mirroring bootstrap. Requires `@velajs/vela >=1.11.0`.

## 0.2.1 (2026-05-14)

### Fixes

- **`compile()` now replicates `bootstrap()`'s global token setup.** Registers `Container`, `ModuleRef`, and `REQUEST_CONTEXT` as global tokens (the last is the canonical seam for the per-request bag that `RouteManager.setRequestInstance` populates). Marks `APP_GUARD/PIPE/INTERCEPTOR/FILTER/MIDDLEWARE` as global so multi-provider pipeline registration via `bindAppProviders` resolves cleanly. Before this fix, guards / services that injected `REQUEST_CONTEXT` (the documented `@CurrentUser` lazy-decorator pattern) crashed at request time with "REQUEST_CONTEXT can only be resolved inside a request". New test pins the behavior end-to-end.
- **Overrides now win for controller-internal constructor injection.** Pre-registering an override at the root container's `__root__` bucket only beat framework-internal lookups (no `requestingModuleId`). Controller constructor injection passes the controller's module id, which finds the module's own registration before the root override and short-circuits. The builder now post-processes after `loader.load()` and overwrites the registration in every module bucket that already holds the token.

### Breaking changes

- **`@velajs/vela` peer bumped to `>=1.6.0`.** Needs `REQUEST_CONTEXT` and `createLazyParamDecorator` re-exports (added in vela 1.6.0).

## 0.2.0 (2026-04-30)

Bugs fixed, rebuilt on `@velajs/vela/internal`, no more `reflect-metadata` dep.

### Fixes

- **Provider override shape was wrong.** `overrideProvider(token).useValue(v)` constructed `{ token, useValue }` but vela's container reads `{ provide, useValue }`. The misleading `as ProviderOptions` cast hid this; nothing actually overrode. Fixed.
- **`useClass` now uses the container's native `useClass` path** instead of the bogus `useFactory: () => new cls()` workaround. The previous comment claimed `Container.registerOptions` doesn't read `useClass` — it does (`vela/src/container/container.ts`).
- **`loader.resolveAllInstances()` is now awaited.** Was called synchronously even though vela's signature is async; lifecycle hooks fired before instance resolution finished.
- **APP\_\* token wiring uses vela's canonical `bindAppProviders` helper.** Replaces the five duplicated `useGlobalGuards/Pipes/Interceptors/Filters/Middleware(container.resolve(APP_*))` blocks that handled only the single-value case (vela switched to array form months ago). Now stays in lockstep with `VelaFactory.create` automatically.

### Breaking changes

- **`@velajs/vela` peer bumped to `>=1.1.0`.** The `optional: true` flag is removed — the package is unusable without vela.
- **`reflect-metadata` dependency removed.** Drop `import 'reflect-metadata'` from your test setup files; vela's built-in polyfill is sufficient.
- **`prepublishOnly` switched from `bun run` to `pnpm run`** to match the rest of the workspace.

### Internal

- **Rebuilt on `@velajs/vela/internal`** for framework primitives (`MetadataRegistry`, `Container`, `RouteManager`, `ModuleLoader`, `ComponentManager`, `VelaApplication`, `bindAppProviders`). Public types still come from `@velajs/vela`.
- **`bun.lock` deleted** — pnpm is the source of truth.

### Migration

```diff
- import 'reflect-metadata';
  import { describe, it, expect } from 'vitest';
  import { Test } from '@velajs/testing';

- @Module({
-   providers: [{ token: SomeToken, useValue: 'x' }],
- })
+ @Module({
+   providers: [{ provide: SomeToken, useValue: 'x' }],
+ })
  class TestModule {}
```

(The `token` → `provide` change applies to your `@Module()` providers, not just to overrides — vela's container has always read `provide`. The previous shape silently no-op'd.)

## 0.1.0 (2026-02-20)

Initial release.

- `Test.createTestingModule()` builder.
- `overrideProvider/Guard/Pipe/Interceptor/Filter` with `useValue/useClass/useFactory`.
- `TestingModule` with `get()`, `createApplication()`, `close()`.
