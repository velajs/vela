# @velajs/crud

Native CRUD module for the [Vela framework](https://github.com/velajs/vela): `@Crud()`,
`CrudModule`, `@Override()`, and a full resource engine — 22 verbs, filtering, pagination,
relations, hooks, policies, multi-tenant, versioning/audit, OpenAPI, and live queries.

```bash
pnpm add @velajs/crud @velajs/crud-memory   # or @velajs/crud-drizzle
```

See the [CRUD guide](https://github.com/velajs/vela/blob/main/docs/crud/README.md) for the full guide.

## Schema-bound resources and features

Wrap every headless feature with `defineCrudFeature()` before passing it to
`CrudModule.forFeature()`. Each wrapper compiles hooks against its model before
features with different schemas enter the same module list.

```ts
import { Module } from '@velajs/vela';
import { CrudModule, defineCrudFeature, defineModel, type CrudConfig } from '@velajs/crud';
import { memoryAdapter } from '@velajs/crud-memory';
import { z } from 'zod';

const itemSchema = z.object({ id: z.string(), name: z.string().min(1) });
const itemModel = defineModel({
  name: 'item',
  tableName: 'items',
  schema: itemSchema,
  timestamps: false,
});

const itemConfig = {
  model: itemModel,
  hooks: {
    beforeCreate(_ctx, write) {
      // Write fields are optional, including generated fields such as id.
      if (write.name !== undefined) write.name = write.name.trim();
    },
    afterCreate(_ctx, row) {
      // Persisted rows satisfy the full model schema.
      return { ...row, name: row.name.trim() };
    },
    transformRead(_ctx, row) {
      // Policies or field selection may have removed name.
      return { label: row.name ?? '(hidden)' };
    },
  },
} satisfies CrudConfig<typeof itemSchema.shape>;

@Module({
  imports: [
    CrudModule.forRoot({ adapter: memoryAdapter({ tableName: 'items' }) }),
    CrudModule.forFeature([
      defineCrudFeature({ path: '/items', ...itemConfig }),
    ]),
  ],
})
export class ItemsModule {}
```

A feature's controller is generated, so declare its route metadata in the config:
`decorators` apply to the controller class and `endpointDecorators` to each
endpoint's handler, as if written above them in order. Endpoint metadata
overrides the class's, and an `@Override`'d endpoint keeps it. Declare
authorization policy this way, such as Cedar's default deny:

```ts
defineCrudFeature({
  path: '/notes',
  model: noteModel,
  decorators: [RequireResource({ action: 'note:write', resourceType: 'Note' })],
  endpointDecorators: {
    list: [CedarPublic()],
    read: [RequireResource({ action: 'note:read', resourceType: 'Note', idParam: 'id' })],
  },
});
```

These decorators declare metadata; one that returns a replacement class or
descriptor is rejected, so supply a custom handler with `@Override()` instead.

`CrudConfig<Shape>` and `ResourceConfig<Shape>` take the Zod object's **schema
shape**, such as `typeof itemSchema.shape`. Inline hooks in `@Crud()`,
`defineCrudFeature()`, and `defineResource()` infer their field types from the
model. Use `satisfies` as above when extracting a config into a variable.

Programmatic resources use the same contract:

```ts
import { defineResource, type CrudResource, type ResourceConfig } from '@velajs/crud';

// Uses itemConfig and itemSchema from the example above.
const resourceConfig = {
  ...itemConfig,
  adapter: memoryAdapter({ tableName: 'items' }),
} satisfies ResourceConfig<typeof itemSchema.shape>;

const resource: CrudResource = defineResource('items', resourceConfig);
```

Compiled `CrudResource` has no caller-selected row generic. Before-write hooks
receive schema-validated partial writes; persisted-row hooks receive full
validated records. Read/list transforms receive partial rows after masking or
projection. Additional fields outside the schema remain `unknown`. Transform
outputs are `unknown`, and `afterList` receives `Page<unknown>` because a
transform may return a different shape or a scalar.

The engine validates adapter rows against the model before passing them to
typed hooks or policies. Missing required fields and incompatible database
values are rejected. Align the model with the database's actual persisted
records; a partial write does not establish that the returned row is complete.
Hook replacement values and in-place mutations are validated before they
re-enter the engine. Database defaults belong in the adapter/database contract;
schema parsing does not persist a missing database value.

## Custom adapters

Adapters expose an explicit `runtime` capability view for the engine. Build
custom dynamic adapters with `bindAdapter()` from `@velajs/crud/adapter`. When
overriding an existing adapter, spread `base.runtime` and bind the result so the
engine sees the overrides:

```ts
import { bindAdapter } from '@velajs/crud/adapter';
import { memoryAdapter } from '@velajs/crud-memory';

const base = memoryAdapter({ tableName: 'items' });
let listCalls = 0;
const instrumented = bindAdapter({
  ...base.runtime,
  async list(query, scope) {
    listCalls += 1;
    return base.runtime.list(query, scope);
  },
});
```

Spreading a bound adapter without rebinding copies its existing `runtime`
reference, leaving engine calls attached to the original implementation.
`bindAdapter()` describes dynamic record operations; narrower persisted-row
types require a real parser, such as a typed adapter's `parseRow` option.

## Request scopes and pagination

Custom adapters must implement `requestScope(fn, context)` separately from
`transaction(fn, context)`. Read, list, search, aggregate, and export use ordinary
request scopes; operations needing rollback use transactions. Both receive the
trusted request tenant. A request scope may internally open a transaction when
needed for database session isolation.

Cursor pagination validates versioned tokens at the engine boundary and adds
all primary keys after the configured cursor field to disambiguate ties.
Cursor pagination uses next-only ascending ordering; offset pagination supports sorting.
Null cursor values sort first; compound tokens retain scalar/date types and
Unicode. Invalid, wrong-field, and wrong-type tokens fail with 400.

Adapters receive `options.keyset` (fields, direction, decoded boundary), never
an unvalidated client token. Custom adapters must order and compare the full
tuple. Arbitrary read policies paginate only authorized rows and use the same
tuple ordering, retaining tenant-scoped totals.

## License

MIT

## Standard Schema and edge capabilities

See the [edge capabilities guide](../../docs/edge-capabilities.md) for asynchronous
validation, tenant admission, Cedar authorization, compound IDs, scoped cursors,
commit hooks, encryption, and backend guarantees.

## Typed headless services

`bindCrudService(resource, contracts)` from `@velajs/crud/service` provides typed
create/read/update/delete/list methods over the same validated, policy-aware
resource engine. Input and response types stay distinct through transformations;
results retain status, headers and pagination. Pass the actual resource contracts
and an explicit admitted context per invocation. See
[typed headless services](../../docs/crud/services.md) for authoring and DI examples,
conditional reads, and the default-envelope/afterList compatibility boundary.

## Named databases and composed transactions

Use `defineCrudDatabase`, `createCrudDatabaseRegistry`, and
`databaseResource(database, resourceKey)` to mount the same model against multiple
application-owned databases. `CrudModule.forRoot({ databases })` and
`forFeature(features, { database })` keep selection explicit; existing
`forRoot({ adapter })` remains supported. Native handle and model types stay inferred.

`crudTransaction(adapter, context, callback)` composes sequential resource calls
through `EngineRequest.transaction` on one owned database, with outer-commit
notifications and rollback on failed operations. D1 callback composition and
cross-database atomicity are unsupported. See the
[multi-database guide](../../docs/multi-database.md) and the
[two-D1 Worker](../../apps/multi-database/README.md) for routing, transaction limits,
and per-database migration ownership.

## Atomic write batches

Optional `atomicBatch` adapters accept precomputed typed commands through
`requireAtomicBatch` and `executeAtomicBatch`. Related writes and audit commands
can share one database commit without callback transactions. CRUD resources may
opt into **metadata-only** atomic auditing with
`auditPersistence: { mode: 'atomic', snapshots: 'none' }`; ordinary post-commit
auditing remains the default. See [atomic writes](../../docs/atomic-writes.md)
for ownership, predicates, supported configurations, and committed error handling.


Version history and `auditPersistence: { mode: 'transaction' }` participate in
owned CRUD transactions. Versioned resources require a same-owner transaction
store; plain independent stores are rejected before writes. See
[transactional history](../../docs/transactional-history.md) for schema migration,
tenant isolation and the `withCrudTransactionStore` native integration helper.
