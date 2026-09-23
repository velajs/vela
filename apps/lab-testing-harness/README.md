# Lab Testing Harness

Fake consumer project for `@velajs/testing` and `@velajs/vela`, linked from the
workspace. It exercises the public testing API from a separate project and runs
in Node (a **Node host**, not a Worker).

From the workspace root:

```sh
pnpm --dir apps/lab-testing-harness typecheck
pnpm --dir apps/lab-testing-harness test
```

Vitest compiles the tests with Oxc; `vitest.config.ts` asks it for the legacy
decorators and `design:paramtypes` metadata Vela reads.

Covered behaviors:

- `Test.createTestingModule()` and `TestingModuleBuilder`.
- `TestingModule.get()`, `createApplication()`, and `close()`.
- `OverrideBy` chaining.
- Provider overrides with `useValue`, `useClass`, and `useFactory`.
- Guard, pipe, interceptor, and filter overrides in HTTP controller tests.
- Lifecycle hooks during compile and close.
- One module-scope `LabModule` compiled by every test: overrides and the
  lifecycle log belong to each compiled module, so no registry reset is needed.
