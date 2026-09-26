# Hyperdrive CRUD

One `pg.Client` per Vela invocation, built from the native
`env.HYPERDRIVE.connectionString`, with Drizzle and the existing CRUD adapter.
The application module can be cached across requests; its request factory opens
no connection during bootstrap. `client.end()` runs once after managed work and
any streamed response finish. There is no application-global client or pool.

Use Node 24+ and pnpm 11.11.0 from the workspace root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @velajs/cloudflare... --filter @velajs/crud-drizzle... build
pnpm --filter vela-hyperdrive-crud types
pnpm --filter vela-hyperdrive-crud typecheck
pnpm --filter vela-hyperdrive-crud build
```

For local development, supply an **isolated disposable PostgreSQL database**.
Apply `migrations/0001_items.sql` to that database, set
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` to its connection URL
(including a password), copy `.dev.vars.example` to `.dev.vars` and choose a local
token, then run `pnpm --filter vela-hyperdrive-crud dev`. Send
`Authorization: Bearer <local token>` to `/items`. The empty token in committed
configuration denies every request. Vite explicitly disables remote bindings;
local Hyperdrive forwards to local PostgreSQL and does not emulate edge pooling
or query caching. The placeholder Hyperdrive ID is not a usable cloud resource.

`POST /items` accepts `{ "id": "synthetic-1", "title": "Example" }`.
`GET`, `PATCH`, and `DELETE /items/synthetic-1` use the same existing CRUD routes.
This example's bearer token protects a synthetic fixture; production applications
must establish their own trusted identity, authorization and tenant policies.

## Lifecycle and freshness

The factory allocates a client in `acquire` and connects in `create`. This puts
connection failures and Drizzle/registry construction failures inside the cleanup
boundary. Driver connection and statement timeouts bound network work. Abort is
cooperative: it cannot undo an issued query or close a socket while awaited work
is still running. Always await database work or register it with the execution
lifetime. Raw client/Drizzle handles must never be retained outside that invocation.

All names within one lease share an exclusion gate. Await independent operations
sequentially; inside a composed transaction, pass the same explicit
`EngineRequest.transaction` to every resource. Build audit/version stores from
that lease's exact Drizzle handle. Never substitute another client's store.

Use a **cache-disabled Hyperdrive configuration** for this example. Hyperdrive's
query cache does not invalidate matching reads after writes. Vela invalidation,
ETags, and committing a transaction do not purge that cache. Cached configurations
are suitable only for explicitly stale-tolerant reads; use a separate client and
binding for those reads. Authorization, tenant authority, history, and immediate
read-after-write checks must use fresh reads. The connection string alone does
not let this code verify the configuration's cache policy.

Cloudflare maintains the origin pool and automatically cleans up invocation
connections. Explicit `end()` makes the generic ownership boundary deterministic
and works in local PostgreSQL tests too. It does not close Hyperdrive's origin
pool. A failed release is attempted once; Vela's existing container disposal logs
it and continues disposing other providers. Standalone `lease.dispose()` rejects.

Sources: [Cloudflare lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/),
[query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/),
[pg transaction ownership](https://node-postgres.com/features/transactions),
[Cloudflare Drizzle example](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/).

## Verification and optional live acceptance

The repository's `tests/crud/hyperdrive.postgres.test.ts` builds this exact Vite
Worker and runs it in Miniflare/workerd against `VELA_POSTGRES_URL`. The URL must
include a password and point to a disposable database. It creates the fixed
`lifecycle_items` fixture table only when absent and drops only that created table.
It refuses to overwrite an existing table. The adjacent request-database suite
uses unique schemas and proves rollback of rows, audit and versions before release.

```sh
VELA_POSTGRES_URL='<disposable local PostgreSQL URL>' pnpm test:postgres
```

Real remote acceptance is opt-in. Supply an **already running** copy of this
synthetic Worker, its access token, and an already configured cache-disabled
Hyperdrive binding pointing at a pre-existing synthetic database with this
migration applied. This command does not deploy, provision, change bindings or
apply migrations. It creates three random test rows, checks concurrent creates and
immediate reads after updates, and attempts to delete only those rows. A killed run
or timed-out write can leave rows behind: settling an HTTP request does not prove
the remote write stopped. Failures report the generated synthetic IDs for operator
reconciliation; the runner does not retry mutations automatically:

```sh
VELA_HYPERDRIVE_ACCEPTANCE_URL='https://your-existing-synthetic-worker.example' \
VELA_HYPERDRIVE_ACCEPTANCE_TOKEN='<existing access token>' \
VELA_HYPERDRIVE_ACCEPTANCE_CONFIRM='pre-existing-synthetic-cache-disabled' \
pnpm --filter vela-hyperdrive-crud test:live
```

No remote resources or credentials are provided by the repository. Local tests
cannot prove Cloudflare edge pooling, cache configuration, regional behavior,
platform cancellation deadlines or abrupt-isolate cleanup. Passing the remote
fixture verifies its requests; it does not independently inspect account settings.
