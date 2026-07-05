# CRUD (`@velajs/crud`)

Generate full REST resources from a data model. `@velajs/crud` bridges [hono-crud](https://www.npmjs.com/package/hono-crud) + `@hono/zod-openapi` into Vela's controller/module/DI world, so a single `@Crud()` config mounts create/list/read/update/delete (plus search, batch, versioning, …) with matching OpenAPI. Peer deps: `@velajs/vela`, `hono`, `hono-crud`, `@hono/zod-openapi`, `zod`.

## How it wires into Vela — `RouteContributor` self-registration

Merely **importing** `@velajs/crud` runs a module side-effect that calls `registerRouteContributor({ id: 'crud', claimsMetaKey: 'vela:crud', ... })` on the main `@velajs/vela` export. Vela then consults this contributor **after** explicit `@Get/@Post` routes — both at route-build time and during OpenAPI generation — for every controller carrying `vela:crud` metadata (the metadata `@Crud()` and `CrudModule.forResource` stamp). Registration is last-writer-wins and idempotent, so import order never matters. This register-based inversion is what keeps CRUD bundleable on Cloudflare Workers (no runtime `await import('@velajs/crud')`).

## Authoring style 1 — `@Crud()` on a controller

```ts
import { Controller, Get } from '@velajs/vela';
import { Crud, Override } from '@velajs/crud';
import { defineMeta, defineModel, MemoryAdapters } from 'hono-crud';
import { z } from 'zod';

const UserModel = defineModel({ tableName: 'users', schema: z.object({ id: z.string(), name: z.string(), email: z.string() }), primaryKeys: ['id'] });
const userMeta = defineMeta({ model: UserModel });

@Controller('/users')
@Crud({ meta: userMeta, adapters: MemoryAdapters, only: ['create', 'list', 'read'] })
class UserController {
  @Get('/me')                       // hand-written routes coexist with generated ones
  getMe() { return { id: 'current-user' }; }

  @Override('list')                 // replace just the generated `list` route
  customList(c: Context) { return c.json({ result: store.all() }); }
}
```

Register `UserController` in a module's `controllers` as usual. `defineModel`/`defineMeta`/`MemoryAdapters` come from `hono-crud` (+ `@hono-crud/memory`), not from this package.

## Authoring style 2 — `CrudModule.forResource` / `defineCrudResource`

No controller class needed — mount a resource straight into `imports`:

```ts
import { CrudModule, defineCrudResource } from '@velajs/crud';

// forResource(path, config) → DynamicModule with a synthetic controller
@Module({ imports: [CrudModule.forResource('/posts', { meta: postMeta, adapters: MemoryAdapters, guards: [AuthGuard] })] })
class AppModule {}

// defineCrudResource bundles forResource + programmatic per-endpoint overrides
const users = defineCrudResource({
  path: '/users',
  meta: userMeta,
  adapters: MemoryAdapters,
  only: ['list', 'create'],
  overrides: { list: (c) => c.json({ items: store.all() }) },  // same effect as @Override('list')
});
```

`ResourceConfig` = `CrudConfig` + `guards?: GuardType[]`. `defineCrudResource`'s config adds the required `path` and an `overrides?: Partial<Record<CrudEndpointName, (c) => unknown>>` map. Two `forResource` calls with the same path dedup (keyed by path); different paths are distinct module instances.

> **Which style carries which options.** The `@Crud()` decorator stores the whole config, so every `CrudConfig` field works there. `CrudModule.forResource` (and `defineCrudResource`, which routes through it) currently forward only `meta, adapters, only, except, endpoints, tenantResolverMounted` (+ `guards`) to the route builder — so put `hooks`, `dto`, `responseEnvelope`, `name`, and `namePlural` on a `@Crud()` controller.

## `CrudConfig` options

| Option | Type | Notes |
|---|---|---|
| `meta` | `MetaInput` | Model meta from `defineMeta({ model })`. Required. |
| `adapters` | `AdapterBundle` | e.g. `MemoryAdapters`, `DrizzleAdapters`. Required. |
| `only` | `CrudEndpointName[]` | Explicit allow-list. Loud-fails if the adapter lacks a requested verb. |
| `except` | `CrudEndpointName[]` | Subtract from the default set. |
| `endpoints` | `{ [K in CrudEndpointName]?: ... }` | Per-endpoint config forwarded to hono-crud's `defineEndpoints`. |
| `hooks` | `CrudHooks` | Flat before/after sugar (see below). |
| `dto` | `{ create?, update? }` | Per-route Zod body-schema overrides (→ hono-crud `bodySchema`). |
| `name` / `namePlural` | `string` | Drive derived OpenAPI operationIds; default `meta.model.tableName` (+ `"s"`). |
| `responseEnvelope` | `ResponseEnvelope` | Final formatter for every response (see below). |
| `tenantResolverMounted` | `boolean` | Affirm an upstream tenant resolver — required for tenant-scoped models. |

### Endpoints

`CrudEndpointName` covers `create · list · read · update · delete · search · aggregate · restore · batchCreate · batchUpdate · batchDelete · batchRestore · batchUpsert · export · import · upsert · clone · bulkPatch` plus the four **version verbs** `versionHistory · versionRead · versionCompare · versionRollback`. With no `only`/`except`, every verb the **adapter bundle ships** is enabled (first-party Memory/Drizzle/Prisma bundles fill all slots). Version verbs are additionally gated: they only default-on when the model declares `versioning` (an explicit `only` still requests them). Unknown names in `only`/`except`/`endpoints` throw a `@Crud: unknown endpoint name` error at load.

Routes mount under `{globalPrefix}{controllerPath}` (via hono-crud's `registerCrud`). Note **`update` is `PATCH`**, not PUT:

| Verb | Route | | Verb | Route |
|---|---|---|---|---|
| `create` | `POST /` | | `read` | `GET /:id` |
| `list` | `GET /` | | `update` | `PATCH /:id` |
| `search` | `GET /search` | | `delete` | `DELETE /:id` |
| `aggregate` | `GET /aggregate` | | `restore` | `POST /:id/restore` |
| `export` | `GET /export` | | `clone` | `POST /:id/clone` |
| `import` | `POST /import` | | `upsert` | `POST /upsert` |
| `bulkPatch` | `PATCH /bulk` | | `batchCreate` | `POST /batch` |
| `batchUpdate` | `PATCH /batch` | | `batchDelete` | `DELETE /batch` |
| `batchRestore` | `POST /batch/restore` | | `batchUpsert` | `POST /batch/upsert` |
| `versionHistory` | `GET /:id/versions` | | `versionRead` | `GET /:id/versions/:version` |
| `versionCompare` | `GET /:id/versions/compare` | | `versionRollback` | `POST /:id/versions/:version/rollback` |

## Overrides — `@Override(endpoint)`

`@Override('update')` marks a controller method as the implementation for one generated route; the rest stay generated. The override runs as **middleware on that route**: return a value to short-circuit the generated handler, or call `next()` to fall through. Methods are prototype-bound (no instance state) and receive the Hono `Context` directly — write `(c: Context) => c.json(...)`. `getOverrides(controller)` reads the recorded entries.

## Guards & middleware

Controller `@UseGuards(...)` and `@UseMiddleware(...)` apply to generated routes exactly as to hand-written ones — a denied guard yields `403`, controller middleware runs ahead of guards and every handler. `CrudModule.forResource`'s `guards` array registers controller-level guards for the synthetic controller.

## Response envelopes

Default (omit `responseEnvelope`) is byte-identical to hono-crud's classic shape: `{ success: true, result }` for single records, `{ success: true, result, result_info }` for list/search (where `result_info` carries `page`, `per_page`, `total_count?`, `has_next_page`, `next_cursor?`, …), and `{ success: false, error: <StructuredError> }` for errors (creates return `201`). Override the final formatting step per resource — on the `@Crud()` decorator:

```ts
@Controller('/posts')
@Crud({
  meta, adapters,
  responseEnvelope: {
    success: (result, info) => (info ? { data: result, meta: info } : { data: result }),
    error:   (err) => ({ error: { code: err.code, message: err.message } }),
  },
})
class PostController {}
```

`ResponseEnvelope`, `ResponseEnvelopeInfo`, and `StructuredError` are re-exported from `@velajs/crud` so you need not import them from `hono-crud`.

## Hooks

`CrudHooks` is flat sugar over hono-crud's per-endpoint hooks: `beforeCreate/afterCreate`, `beforeList/afterList`, `beforeRead/afterRead`, `beforeUpdate/afterUpdate`, `beforeDelete/afterDelete`. Each handler receives a `HookContext` (transaction handle + `tenantId`, `organizationId`, `userId`, `agentId`, `agentRunId`) as the **first** argument, then the relevant data. `afterUpdate(ctx, prior, current)` and `afterDelete(ctx, prior)` expose the two-snapshot shape for server-side diffs. Per-endpoint hooks set via `endpoints.{name}.hooks` win over flat sugar.

## Tenant scoping (fail-fast)

When the resolved model is tenant-scoped — `model.multiTenant === true | MultiTenantConfig`, or `model.policies.readPushdown` is set — `@velajs/crud` throws `MissingTenantResolverError` **synchronously at module-load** unless you affirm `tenantResolverMounted: true`. This guards a data-loss bug class: without an upstream resolver, `HookContext.tenantId` / `CrudEventPayload.tenantId` silently propagate as `undefined`. Fix by mounting hono-crud's `multiTenant()` (or an equivalent that calls `c.set('tenantId', ...)`) on the parent app, then setting the flag:

```ts
import { multiTenant } from 'hono-crud';
app.use('/*', multiTenant());
CrudModule.forResource('/posts', { meta: postMeta, adapters, tenantResolverMounted: true });
```

The flag is an affirmation, not a probe — the bridge cannot introspect Hono's middleware stack. `isTenantScopedMeta(meta)` exposes the same predicate.

## `CrudService` (DI-injectable adapter binding)

`CrudService<T>` is an abstract base for wrapping an adapter bundle + meta as an injectable provider:

```ts
@Injectable()
class UserService extends CrudService<User> {
  readonly meta = defineMeta({ model: UserModel });
  readonly adapters = MemoryAdapters;
}
```

## OpenAPI

The contributor's `buildCrudOpenApiPaths` reuses the exact endpoints-def helper the route builder uses, so the emitted spec can never drift from the mounted routes. OperationIds are derived from `name`/`namePlural` with two remaps (`read`→`get`, `batch*`→`bulk*`); single-record verbs use the singular, list/bulk verbs the plural (e.g. `listUsers`, `getUser`, `bulkDeleteUsers`). A per-endpoint `openapi.operationId` still wins. See `references/openapi.md` for mounting the document.
