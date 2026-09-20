# Harbor CRUD API

Runnable consumer project for the native `@velajs/crud` (workspace-linked). Shows both
consumption styles: a decorated controller (`/containers` — hooks, a hand-written route,
an `@Override`, a guard) and a headless resource (`/berths` via `CrudModule.forFeature`).

```bash
pnpm --filter harbor-crud-api test     # in-process smoke suite
pnpm --filter harbor-crud-api dev      # build + serve on :3000
```

All requests to `/containers` need the guard header: `X-Harbor-Key: letmein`.
