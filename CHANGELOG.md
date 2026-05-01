# Changelog

## 0.2.0 (2026-04-30)

Bugs fixed, rebuilt on `@velajs/vela/internal`, no more `reflect-metadata` dep.

### Fixes

- **Provider override shape was wrong.** `overrideProvider(token).useValue(v)` constructed `{ token, useValue }` but vela's container reads `{ provide, useValue }`. The misleading `as ProviderOptions` cast hid this; nothing actually overrode. Fixed.
- **`useClass` now uses the container's native `useClass` path** instead of the bogus `useFactory: () => new cls()` workaround. The previous comment claimed `Container.registerOptions` doesn't read `useClass` — it does (`vela/src/container/container.ts`).
- **`loader.resolveAllInstances()` is now awaited.** Was called synchronously even though vela's signature is async; lifecycle hooks fired before instance resolution finished.
- **APP_* token wiring uses vela's canonical `bindAppProviders` helper.** Replaces the five duplicated `useGlobalGuards/Pipes/Interceptors/Filters/Middleware(container.resolve(APP_*))` blocks that handled only the single-value case (vela switched to array form months ago). Now stays in lockstep with `VelaFactory.create` automatically.

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
