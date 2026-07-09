# @velajs/crud

Native CRUD for the [Vela framework](https://github.com/velajs/vela) — a full resource engine
(22 verbs, filtering, pagination, relations, hooks, policies, multi-tenant, versioning/audit,
OpenAPI, live queries) built the Vela way: decorators, DI, guards, and Zod DTOs.

This repository is a pnpm workspace:

| Package | Description |
| --- | --- |
| [`@velajs/crud`](packages/core) | The engine + Vela module (`@Crud()`, `CrudModule`, `@Override()`) |
| [`@velajs/crud-memory`](packages/memory) | In-memory adapter — tests, prototypes, examples |
| [`@velajs/crud-drizzle`](packages/drizzle) | Drizzle ORM adapter (pg, mysql, sqlite) |

## Development

```bash
pnpm install
pnpm -r typecheck && pnpm -r build && pnpm test
```

Releases are managed with [changesets](https://github.com/changesets/changesets); the three
packages version together as a fixed group.

## License

MIT
