# Two databases in one Worker

This local example mounts the same `item` model and `items` SQL table at
`/primary/items` and `/analytics/items`. Each D1 binding stores independent rows.
`AppModule` is declared once. `CrudModule.forRootAsync({ inject: [ENV] })` receives
each native environment as `VelaEnv` and returns `{ databases }`, a registry with
both typed Drizzle handles, and each resource selects its database by name
(`database: 'primary'`). `pnpm types` regenerates the D1 binding types in
`worker-configuration.d.ts`. The registry preserves native queries
(`databases.get('primary').handle.query.items`) and adapter row types.

From the workspace root, after `pnpm install --frozen-lockfile`:

```sh
pnpm --filter @velajs/cloudflare... build
pnpm --filter @velajs/crud-drizzle... build
pnpm --filter vela-multi-database db:primary
pnpm --filter vela-multi-database db:analytics
pnpm --filter vela-multi-database dev
```

`dev` runs `vite dev` on port 8792. Vite 8 and `@cloudflare/vite-plugin` run
`src/worker.ts` in workerd with both local D1 databases; there is no separate
compile step. `oxc.config.ts` asks Oxc for the legacy decorators and
`design:paramtypes` metadata Vela reads, for both `vite.config.ts` and
`vitest.config.ts`. `build` writes the deployable Worker to `dist/`, and
`pnpm --filter vela-multi-database run deploy` builds and uploads it with
Wrangler. `pnpm --filter vela-multi-database test` migrates both test databases
in workerd, writes the same id through each route, and checks that two
environments build separate database registries from the one `AppModule`.

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
