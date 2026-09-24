# CRUD (`@velajs/crud`)

`@velajs/crud` is Vela's native CRUD engine (the hono-crud bridge is gone as of 1.18).
`@Crud()` stamps REAL controller routes: named routes (`urlFor`), guards/pipes/
interceptors, and OpenAPI all flow through Vela's ordinary pipeline — no
RouteContributor, no import side effects. Requires `@velajs/vela >= 1.18`. Peer deps:
`@velajs/vela`, `hono`, `zod`.

```bash
pnpm add @velajs/crud @velajs/crud-memory    # or @velajs/crud-drizzle
```

## Model + decorated controller

```ts
import { Controller, Get, UseGuards } from '@velajs/vela';
import { Crud, CrudCtx, Override, defineModel, type CrudRequestContext } from '@velajs/crud';
import { memoryAdapter } from '@velajs/crud-memory';
import { z } from 'zod';

const User = defineModel({
  name: 'user',
  tableName: 'users',
  schema: z.object({
    id: z.uuid(),
    email: z.email(),
    name: z.string().min(1),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
    deletedAt: z.number().nullable().optional(),
  }),
  softDelete: true,          // enables restore/batchRestore; delete soft-stamps
  // timestamps default ON ({ createdAt, updatedAt }, epoch-ms); set false to opt out
});

@Controller('/users')
@UseGuards(AuthGuard)        // runs on every generated route
@Crud({
  model: User,
  adapter: memoryAdapter({ tableName: 'users', softDeleteField: 'deletedAt' }),
  only: ['create', 'list', 'read', 'update', 'delete'],
  filterFields: ['email', 'name'],
  sortFields: ['email'],
  searchFields: ['name'],
  upsert: { keys: ['email'] },              // enables the upsert family
  hooks: {
    beforeCreate: (ctx, data) => ({ ...data, name: data.name?.trim() }),
    afterUpdate: (ctx, prior, current) => audit(ctx, prior, current), // two-snapshot, in-tx
  },
})
export class UsersController {
  @Get('/stats') stats() { return { ok: true }; }  // hand-written routes match before /:id

  @Override('list')                          // first-class takeover, keeps the users.list name
  list(@CrudCtx() ctx: CrudRequestContext) { /* your handler */ }
}
```

Route names are `<name>.<verb>` (`users.list`, `users.read`, ...) — they appear in
`vela route list`, generate URLs via `UrlGeneratorService.urlFor`, and derive stable
OpenAPI operationIds (`listUsers`, `getUser`).

## Headless resources + app-wide defaults

```ts
import { CrudModule, defineCrudFeature } from '@velajs/crud';

@Module({
  imports: [
    CrudModule.forRoot({ adapter: memoryAdapter({ tableName: 'users' }) }),
    CrudModule.forFeature([
      defineCrudFeature({ path: '/users', model: User }),
      defineCrudFeature({ path: '/posts', model: Post, only: ['create', 'list', 'read'] }),
    ]),
  ],
})
class AppModule {}
```

`crudResourceToken(name)` injects the compiled engine (`resource.execute(verb, req)`)
for programmatic dispatch. `forRoot` also takes `versioningStore`/`auditStore` defaults.

A headless resource's controller is generated, so declare its route metadata in the
config: `decorators` apply to the controller class and `endpointDecorators` to each
endpoint's handler, as if written above them in order (endpoint metadata overrides
class-level metadata; `@Override`'d endpoints keep it). Use them for authorization
policy, such as Cedar's default deny:

```ts
defineCrudFeature({
  path: '/notes',
  model: Note,
  decorators: [RequireResource({ action: 'note:write', resourceType: 'Note' })],
  endpointDecorators: {
    list: [CedarPublic()],
    read: [RequireResource({ action: 'note:read', resourceType: 'Note', idParam: 'id' })],
  },
});
```

A method decorator that changes or returns the descriptor wraps the handler the route
calls, `@Override` handlers included. Class decorators apply after the generated
handlers exist, so one that decorates or wraps each method reaches every endpoint.
Applying last, a class decorator that writes method metadata overrides an
`endpointDecorators` value for that key, exactly as in hand-written TypeScript; a
class decorator returning a replacement class is rejected.

Use `defineCrudDatabase(name, { handle, resources })` and the application-owned
database registry for multiple connections. Select the database explicitly with
`databaseResource(database, resourceName)` or a configured default. Named
resource tokens use `crudResourceToken(name, databaseName)`. Never select a
database through mutable process-global state; same-named resources on separate
databases must keep distinct identities, stores, and live invalidation tags.

`bindCrudService` from `@velajs/crud/service` exposes typed headless operations
against a resource's actual create/update/response contracts. Pass raw input and
explicit invocation context; the engine owns schema transformations and policy
checks. Custom envelopes and post-response replacements stay on `execute()`.

`crudTransaction(adapter, context, async transaction => ...)` joins explicitly
passed resource operations sharing the same registered owner and tenant. Await
each operation. Foreign/expired scopes and cross-database composition fail;
accepted unawaited work is drained before rollback. D1 does not gain callback
transactions from this API. Native scopes also expire with their owning
application registration; retaining the raw handle does not transfer a scope.

`defineCrudFeature` compiles each model's hooks before heterogeneous features enter the module list. Extracted configs use `satisfies CrudConfig<typeof Schema.shape>` or `ResourceConfig<typeof Schema.shape>`. `defineResource` builds the same headless contract; compiled resources do not accept a caller-selected row type.

The engine validates persisted adapter rows against the model. Before-write hooks receive partial schema-validated writes; persisted-row hooks receive complete records; projection/masking transforms receive partial rows and can return unknown output. Do not assert a projected row is the full stored type.

## The 22 verbs

The default exposes only create/list/read/update/delete. Extended verbs require explicit `only` opt-in. Available operations include the core five + `restore`/`clone`/`upsert`, batch family (`/batch`, `/batch/restore`,
`/batch/upsert`) + `bulkPatch` (`PATCH /bulk`, `X-Confirm-Bulk` above the confirm
threshold), `search` (weighted fields, any|all|phrase), `aggregate` (multi-op:
`?count&sum=amount&avg=age`, camelCase aliases, groupBy/having/ordering), `export`
(`?format=csv|json`), `import` (CSV/JSON, per-row results), and four version verbs
(gated on `versioning: true` + a `VersioningStore`).

Envelopes: success `{ success: true, result[, result_info] }`, errors
`{ success: false, error: { code, message, details? } }` (create 201, delete returns
`{ deleted: true }`, upsert carries a `created` flag). Override with
`responseEnvelope: { success, error }`.

## Multi-tenant and policies

Tenant models require a nonempty trusted tenant context. Header/path/query/custom selectors require a `multiTenant({ validate })` membership check; a tenant header alone is not authority. Mount selection middleware upstream of the built Vela routes and validate against the authenticated identity. There is no trust-bypass flag.

Every operation evaluates `model.policies.operation` before parsing/storage. Aggregation also requires an explicit operation policy and per-operation field allowlists. Nested writes inspect tenant ownership and target create/write policies before mutation. Policy fallback scans are bounded; large operations need database-enforced isolation. Versioning keys include tenant plus the complete primary-key tuple.

## Live queries

`live: true` (or `{ tags?: (c) => string[], room?: (c) => string }`) invalidates
`crud:<tableName>` and stamps `Vela-Commit-Cursor`/`Epoch` headers after 2xx writes —
post-commit, pre-flush. Pairs with `@LiveQuery(usersList, { tags: [crudLiveTag('users')] })`, where `usersList` is a `defineLiveQuery({ name: 'users.list', args, result })` definition. Degrades to
a warn-once if `LiveModule` isn't imported.

## Adapters

Adapters separate ordinary `requestScope` from rollback-capable `transaction`, and advertise supported capabilities. Reads do not start transactions merely to obtain a request scope. D1/HTTP adapters must not pretend callback rollback exists. Consult each adapter's capability declaration before enabling atomic operations.

Custom adapters use `bindAdapter` from `@velajs/crud/adapter`. Override `base.runtime` and rebind; spreading a bound adapter leaves its old runtime reference intact. Narrow row types require runtime evidence such as `parseRow`. Cursor tokens are validated at the engine boundary and adapters receive decoded keyset tuples, including all primary keys for stable ties.

Read `packages/crud/README.md` and the selected adapter README for their APIs and capabilities.
