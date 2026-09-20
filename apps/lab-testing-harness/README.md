# Lab Testing Harness

Fake consumer project for `@velajs/testing` installed through `file:../..` and `@velajs/vela` installed through `file:../../../vela`.

It exercises the public testing API from a standalone project:

```sh
pnpm --dir examples/lab-testing-harness install
pnpm --dir examples/lab-testing-harness typecheck
pnpm --dir examples/lab-testing-harness test
```

Covered behaviors:

- `Test.createTestingModule()` and `TestingModuleBuilder`.
- `TestingModule.get()`, `createApplication()`, and `close()`.
- `OverrideBy` chaining.
- Provider overrides with `useValue`, `useClass`, and `useFactory`.
- Guard, pipe, interceptor, and filter overrides in HTTP controller tests.
- Lifecycle hooks during compile and close.
