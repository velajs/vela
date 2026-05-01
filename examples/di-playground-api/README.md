# DI Playground API

Fake consumer project for advanced `@velajs/vela` features installed through `file:../..`.

```sh
pnpm --dir examples/di-playground-api install
pnpm --dir examples/di-playground-api typecheck
pnpm --dir examples/di-playground-api test
pnpm --dir examples/di-playground-api smoke
PORT=8789 pnpm --dir examples/di-playground-api dev
pnpm --dir examples/di-playground-api curl:test
```

The curl suite expects a running server at `BASE_URL`, defaulting to `http://localhost:8789`.

Covered behaviors:

- Direct `Container` usage.
- `ForwardRef`, `forwardRef`, circular provider references, and circular module imports.
- `ModuleRef.get()`, `ModuleRef.resolve()`, and `ModuleRef.create()`.
- `mixin()` guards.
- `@Global()` modules.
- Dynamic modules with `createModuleRef()`.
- `Logger` and `LogLevel`.
- Hono adapter helpers `getRuntimeKey()` and `env()`.
- `ZodValidationPipe`.
- `@velajs/vela/streaming` subpath via `streamText()`.
