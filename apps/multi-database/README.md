# Two databases in one Worker

This local example mounts the same `item` model and `items` SQL table at
`/primary/items` and `/analytics/items`. Each D1 binding stores independent rows.
The environment factory creates both typed Drizzle handles. The registry preserves
native queries (`databases.get('primary').handle.query.items`) and adapter row types.

From the workspace root, after `pnpm install --frozen-lockfile`:

```sh
pnpm --filter @velajs/cloudflare... build
pnpm --filter @velajs/crud-drizzle... build
pnpm --filter vela-multi-database db:primary
pnpm --filter vela-multi-database db:analytics
pnpm --filter vela-multi-database dev
```

```sh
curl -X POST http://localhost:8792/primary/items -H 'Content-Type: application/json' -d '{"id":"same","title":"Primary"}'
curl -X POST http://localhost:8792/analytics/items -H 'Content-Type: application/json' -d '{"id":"same","title":"Analytics"}'
curl http://localhost:8792/primary/items/same
curl http://localhost:8792/analytics/items/same
```

The IDs in `wrangler.jsonc` are local placeholders. For deployment, provision two
real databases and configure bindings separately in each environment. Migration
folders and histories belong to their individual databases. Run the matching
migration command for each target; runtime registration does not apply migrations.

D1 supports native statement batches, not Vela's callback transaction composition.
`crudTransaction` rejects these adapters before invoking the callback. Calls to
both routes do not form a cross-database transaction. See
[the multi-database guide](../../docs/multi-database.md) for SQLite/PostgreSQL,
Durable Object and transactional-memory composition.
