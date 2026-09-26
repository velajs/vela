# Multiple databases

Vela routes CRUD resources to application-owned, named databases. Each registration
contains a native handle, its models and model-specific adapters. Connections and
schemas remain owned by their existing drivers. No ambient “current database” is
set, and importing CRUD does not create a connection.

The [runnable two-D1 Worker](../apps/multi-database/README.md) mounts identical
`item` resources at two paths and demonstrates separate migration histories.

## Register and select

```ts
const primary = defineCrudDatabase('primary', {
  handle: primaryDb,
  resources: {
    item: { model: itemModel, adapter: primaryItemAdapter },
    order: { model: orderModel, adapter: primaryOrderAdapter },
  },
  auditStore: primaryAuditStore,
});
const analytics = defineCrudDatabase('analytics', {
  handle: analyticsDb,
  resources: { item: { model: itemModel, adapter: analyticsItemAdapter } },
  auditStore: analyticsAuditStore,
});
const databases = createCrudDatabaseRegistry([primary, analytics], {
  defaultDatabase: 'primary',
});

@Module({ imports: [
  CrudModule.forRoot({ databases }),
  CrudModule.forFeature([
    defineCrudFeature({ path: '/items', ...databaseResource(primary, 'item') }),
    defineCrudFeature({ path: '/analytics/items', ...databaseResource(analytics, 'item') }),
  ]),
] })
class AppModule {}
```

`databases.get('primary').handle` retains the complete original driver/schema
inference, including Drizzle relational queries. Resource adapter row inference is
preserved on the descriptor. `databaseResource(database, key)` infers the resource's
model and database selector; invalid resource keys and typed registry names fail
TypeScript checks. It does not capture a connection in the controller: the selected
adapter is resolved from the current application's registered database.

For bindings created by async providers, use the ordinary typed provider/module
APIs. The provider's inferred registry type can be retained on its own injection
token; `CrudModule.forRootAsync` awaits its options before compiling resources.
Select each resource's database by name, since the database objects only exist
once the factory runs:

```ts
@Module({ imports: [
  CrudModule.forRootAsync({
    inject: [ENV],
    useFactory: async (env) => ({ databases: await createDatabases(env) }),
  }),
  CrudModule.forFeature([
    defineCrudFeature({ path: '/items', model: itemModel, database: 'primary' }),
    defineCrudFeature({ path: '/analytics/items', model: itemModel, database: 'analytics' }),
  ]),
] })
class AppModule {}
```

Create the handles and stores per environment. In Workers, declare `AppModule`
once at module scope and pass it to `createCloudflareWorker(AppModule)`, as in the
example: the factory receives the native environment typed by `wrangler types`
(`ENV` inside DI) and runs for each application, so every environment gets its
own registry, handles and stores. Reusing a native handle intentionally reuses its
underlying data; separate application registrations still get distinct transaction
capabilities.

Selection order is the resource's `database`, then
`CrudModule.forFeature(features, { database: 'primary' })`, then the registry's
optional `defaultDatabase`. A resource's explicit `adapter` overrides an implicit
default. Combining an explicit database with an explicit adapter is rejected.
The registry resource key defaults to `model.name`; `databaseResource` selects it
explicitly when the registry key differs. Free string selectors support deferred
provider wiring and are checked when resources resolve. `forFeature` resolves
and validates its resources during application creation. Decorated controllers
resolve on first use, as with the existing default-adapter path.

`CrudModule.forRoot({ adapter })`, `@Crud({ model, adapter })`, and
`crudResourceToken('item')` keep their existing single-database meaning. Explicit
named features export `crudResourceToken('item', 'primary')`. The two argument
form cannot alias a legacy token even when its name contains punctuation.
Named HTTP routes use `primary:item.read`; operation IDs include the database
prefix. Commit events include `database` when named. Use
`crudLiveTag('items', 'primary')` for matching named live subscriptions.

Duplicate database bindings, duplicate feature resource identities, unknown names,
model mismatches and foreign relation targets fail closed. Database definitions
list every relation target they use, including targets without HTTP routes.
Relations resolve within that database only; cross-database joins, nested writes
and cascades are unsupported. Fetch from each resource explicitly for an
application-level composition.

Named databases use their own audit/version defaults. They never fall back to
another database's or the legacy root's stores. Default store instances cannot be
shared between registrations. Supply independent stores, or separate wrappers
that explicitly namespace an application-owned backend. Per-resource overrides
remain available and retain their existing semantics.

`CRUD_DATABASES` resolves the application registry for `forRoot` or the invocation registry for `forRequestAsync`. The public
`resolveCrudDatabase(container, runtimeConfig)` helper provides the same selection
for integrations. `resolveCrudDatabaseSync` supports synchronous discovery after
providers initialize; unresolved async providers throw instead of selecting a
fallback. Discovery should use the returned database and resource name together.

## Compose a transaction

`crudTransaction(adapter, context, callback)` accepts adapters declaring real
callback transactions and an explicit owner. Within the callback, pass the scope
as `EngineRequest.transaction`; typed CRUD services forward the same context.
For DI resources, start with the selected resource's adapter so application
ownership is preserved:

```ts
import { runInEntrypointScope } from '@velajs/vela/module-kit';

await runInEntrypointScope(app.getContainer(), async (scope) => {
  const orders = await scope.resolveAsync(crudResourceToken('order', 'primary'));
  const items = await scope.resolveAsync(crudResourceToken('item', 'primary'));
  await crudTransaction({ runtime: orders.config.adapter }, { tenantId }, async (transaction) => {
    await orders.execute('create', { transaction, vars: { tenantId }, body: orderInput });
    await items.execute('update', { transaction, vars: { tenantId }, id: itemId, body: patch });
  });
});
```

Every operation still runs admission, tenant checks, input/row validation,
authorization, hooks and output shaping. Trusted request identity must agree with
the transaction's tenant. A different database/application owner, expired scope,
or fabricated scope is rejected. Any failed joined operation dooms the transaction,
even if the callback catches it or an error envelope formats it.

Await operations sequentially. Concurrent operations on the same capability are
rejected. If the callback returns or throws while an accepted operation is pending,
Vela drains that operation inside the native callback and rolls back; it never
releases the native scope while accepted work is still running. A callback's
original exception remains the reported error.

Commit events and post-commit audit delivery wait for the actual outer commit, run in
operation order, and do not fire after rollback. Delivery failure cannot reverse a
commit; `onAfterCommitError` handles event delivery failures. Audit/event delivery
is best effort, not a durable outbox. External side effects performed inside user
hooks are not database writes and cannot be rolled back by Vela.

Versioned resources and explicit transactional audits bind their stores to the
current owned transaction, including history reads. Unbound or foreign stores
are rejected before writes. See [transactional history](transactional-history.md)
for supported stores, native store bindings and required schema migrations.

| Adapter | Callback composition |
| --- | --- |
| Transactional memory | One shared `MemoryStore`; copy-on-write rollback |
| Drizzle SQLite/libSQL, PostgreSQL | One shared native Drizzle handle; driver transaction |
| Drizzle MySQL | Requires a driver with genuine callback transactions; existing dialect limitations remain |
| Durable Object SQLite | One object's `storage.transaction`; resources may have separate Drizzle wrappers |
| D1 | Rejected before callback execution |
| Prototype memory adapter | Rejected; use `transactionalMemoryAdapter` |

D1's native `batch` is a statement batch, not an arbitrary callback transaction.
Raw native access stays available through the inferred database handle for those
operations. No API promises atomicity across different databases or Durable
Objects. See Cloudflare's [D1 binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
for native batch semantics.

Adapter authors may declare `transactionOwner` only when scopes are mutually
usable across those adapters. Drizzle defaults it to the exact native handle;
its optional override serves native storage wrappers such as Durable Objects.
Do not use a name string or one shared object to combine independent connections.
Drizzle also validates native scope ownership and lifetime at the data boundary.

## Schema and migration ownership

Keep one schema entrypoint, output directory and migration history per database.
Vela model validation does not generate SQL or apply migrations. The example
uses a shared table definition but maintains two independent SQL histories.

Drizzle Kit accepts an explicit config for each database. For example,
`drizzle.primary.config.ts` selects `src/primary/schema.ts` and
`out: './migrations/primary'`; `drizzle.analytics.config.ts` selects its own schema
and `out: './migrations/analytics'`. Both specify their actual dialect. Generate
and review each migration with its corresponding config:

```sh
pnpm exec drizzle-kit generate --config drizzle.primary.config.ts
pnpm exec drizzle-kit generate --config drizzle.analytics.config.ts
```

For PostgreSQL/MySQL/libSQL, configure the matching target credentials and apply
with the existing Drizzle tooling. Keep credentials in the application environment.
See [Drizzle Kit](https://orm.drizzle.team/docs/kit-overview) for per-config commands.

For D1, each Wrangler binding sets its own `database_name`, `database_id` and
`migrations_dir`. Apply each reviewed history to its explicit target:

```sh
pnpm exec wrangler d1 migrations apply vela-multi-primary --local
pnpm exec wrangler d1 migrations apply vela-multi-analytics --local
```

Configure each deployment environment's bindings separately. Choose remote
migration execution explicitly in your deployment procedure; starting the app
never migrates production. Wrangler stores history in each database's migration
table. See [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

## Request-owned connections

`CrudModule.forRootAsync` builds application configuration. A socket opened there
can survive its Worker invocation and cannot be safely reused in later requests.
Use `CrudModule.forRequestAsync` for connected clients:

```ts
CrudModule.forRequestAsync({
  inject: [ENV],
  useFactory: (lifetime, env) => acquireCrudDatabases({
    signal: lifetime.signal,
    acquire: () => new Client({ connectionString: env.HYPERDRIVE.connectionString }),
    create: async (client) => {
      await client.connect();
      const db = drizzle(client);
      return createCrudDatabaseRegistry([
        defineCrudDatabase('primary', {
          handle: db,
          resources: { item: { model: itemModel, adapter: drizzleAdapter({ db, table: items, dialect: 'pg' }) } },
        }),
      ]);
    },
    release: (client) => client.end(),
  }),
});
```

The lifetime is always the first factory argument; `inject` may be omitted when
there are no other dependencies. Import one database registration per application;
combining root and request registrations or two distinct request factories fails
at bootstrap. Reimporting one shared module definition is supported. Put all named
databases in its registry. D1 and other application-owned handles can continue to
use ordinary `forRoot`/`forRootAsync` registrations.

A factory runs lazily once per HTTP or non-HTTP execution scope. Repeated resolves
share its lease. Concurrent acquisition of the same native object is rejected without
releasing its current owner; a failed release quarantines that object. The returned
registry cannot be re-leased or promoted to an
application registration. One lease conservatively admits only one unjoined
database operation at a time, across all its names and stores, since several ORM
wrappers may share one socket. Await work sequentially or pass an existing CRUD
transaction scope. Different invocations have independent clients and can overlap.

`acquireCrudDatabases` owns a handle once `acquire` returns. Put fallible connection
initialization in `create` after allocating the client in `acquire`. If `acquire`
itself fails, it must clean up any partial resource it never returned. Construction
failure releases the acquired handle; if release also fails, an `AggregateError`
retains both failures. Aborting during acquisition waits for acquisition to settle
before releasing. Aborting after acquisition does not close in-flight work.

The invocation disposes the lease after awaited handler work, lifetime-managed
work, and response body completion, error or cancellation. Register detached work
with `lifetime.waitUntil`/`defer`; raw platform `waitUntil` does not extend Vela's
scope. Release runs once, even if it fails. Existing container disposal logs release
errors and continues other disposers; it cannot change an already-sent HTTP
response. Standalone `lease.dispose()` rejects and can be awaited in `finally`.

Compiled `forFeature` resource tokens are invocation-scoped even when their
underlying database is application-owned. Their consumers inherit request scope.
Use a managed HTTP child or `runInEntrypointScope`, as above; root and unmanaged
resolution reject. Metadata and static adapters are validated at bootstrap.
Request factory adapters/stores are validated after acquisition. Resource-token
compilation is cached by DI once per resource per invocation. Standalone
`defineResource` keeps explicit caller ownership.

Framework adapters and stores reject use after release. Native handle references
are not revocable JavaScript capabilities: never retain the raw client, ORM handle,
or original unbound adapters/stores outside their invocation. Inside a transaction,
use its bound stores; do not issue raw queries or start another transaction on the
same client. Trusted tenant context is explicit and is not inherited by event
scopes. Studio's synchronous app-root discovery cannot acquire request databases;
use a separately owned static Studio data source instead of sharing live clients.

See the [Hyperdrive example](../apps/hyperdrive-crud/README.md) for Vite/Oxc setup,
Wrangler types, local PostgreSQL/native Worker coverage, opt-in remote acceptance,
and the required cache-disabled binding for fresh CRUD reads.
