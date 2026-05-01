# Harbor CRUD API

Fake consumer project for `@velajs/crud` installed through `file:../..` and `@velajs/vela` installed through `file:../../../vela`.

It is intentionally a runnable project, not a fixture inside the package test tree. Use it to simulate how a real API consumes the published package surface.

```sh
pnpm --dir examples/harbor-crud-api install
pnpm --dir examples/harbor-crud-api typecheck
pnpm --dir examples/harbor-crud-api test
pnpm --dir examples/harbor-crud-api smoke
PORT=8788 pnpm --dir examples/harbor-crud-api dev
pnpm --dir examples/harbor-crud-api curl:test
```

The curl suite expects a running server at `BASE_URL`, defaulting to `http://localhost:8788`.

Covered behaviors:

- `@Crud()` generated create/list/read/update/delete routes.
- Controller guards applied to generated CRUD routes.
- `dto.create` and `dto.update` request validation.
- Flat hooks through `beforeCreate` and `afterList`.
- `@Override('list')` replacing one generated endpoint while the rest stay generated.
- `CrudService` subclass injection.
- `CrudModule.forResource()` dynamic resource with guards and `only` filtering.
