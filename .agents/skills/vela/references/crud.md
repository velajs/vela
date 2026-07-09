# CRUD (@velajs/crud >= 1.18 — the native engine)

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
  except: ['clone', 'import'],
  filterFields: ['email', 'name'],
  sortFields: ['email'],
  searchFields: ['name'],
  upsert: { keys: ['email'] },              // enables the upsert family
  hooks: {
    beforeCreate: (ctx, data) => ({ ...data, name: data.name.trim() }),
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
@Module({
  imports: [
    CrudModule.forRoot({ adapter: drizzleAdapter({ db, dialect: 'sqlite', table: users }) }),
    CrudModule.forFeature([
      { path: '/users', model: User },
      { path: '/posts', model: Post, only: ['create', 'list', 'read'] },
    ]),
  ],
})
class AppModule {}
```

`crudResourceToken(name)` injects the compiled engine (`resource.execute(verb, req)`)
for programmatic dispatch. `forRoot` also takes `versioningStore`/`auditStore` defaults.

## The 22 verbs

Core five + `restore`/`clone`/`upsert`, batch family (`/batch`, `/batch/restore`,
`/batch/upsert`) + `bulkPatch` (`PATCH /bulk`, `X-Confirm-Bulk` above the confirm
threshold), `search` (weighted fields, any|all|phrase), `aggregate` (multi-op:
`?count&sum=amount&avg=age`, camelCase aliases, groupBy/having/ordering), `export`
(`?format=csv|json`), `import` (CSV/JSON, per-row results), and four version verbs
(gated on `versioning: true` + a `VersioningStore`).

Envelopes: success `{ success: true, result[, result_info] }`, errors
`{ success: false, error: { code, message, details? } }` (create 201, delete returns
`{ deleted: true }`, upsert carries a `created` flag). Override with
`responseEnvelope: { success, error }`.

## Multi-tenant

```ts
import { multiTenant } from '@velajs/crud';
// model: multiTenant: true; the config MUST affirm tenantResolverMounted: true
// (else MissingTenantResolverError at decoration — silent tenant loss is data loss).
// Mount the resolver UPSTREAM of the Vela app (routes build at create() time):
outer.use('*', multiTenant());               // X-Tenant-ID by default; path/query/jwt/custom too
outer.route('/', app.getHonoApp());
```

The engine scopes every lookup/list and stamps the tenant on create from the
resolved context var.

## Live queries

`live: true` (or `{ tags?: (c) => string[], room?: (c) => string }`) invalidates
`crud:<tableName>` and stamps `Vela-Commit-Cursor`/`Epoch` headers after 2xx writes —
post-commit, pre-flush. Pairs with `@LiveQuery({ tags: ['crud:users'] })`. Degrades to
a warn-once if `LiveModule` isn't imported.

## Adapters

One plain-object `CrudAdapter`: `transaction()` + five core methods + optional native
methods declared via `capabilities` (loud `ConfigurationException` on mismatch at
definition time). Adapters that soft-delete must implement `restore`. See
`@velajs/crud/adapter` to write one; `packages/core/PARITY.md` in the crud repo tracks
deviations from hono-crud 0.13 and the families intentionally not ported (cache,
rate-limit, idempotency, MCP, events, encryption, serialization profiles, prisma).
