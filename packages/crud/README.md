# @velajs/crud

Native CRUD module for the [Vela framework](https://github.com/velajs/vela): `@Crud()`,
`CrudModule`, `@Override()`, and a full resource engine — 22 verbs, filtering, pagination,
relations, hooks, policies, multi-tenant, versioning/audit, OpenAPI, and live queries.

```bash
pnpm add @velajs/crud @velajs/crud-memory   # or @velajs/crud-drizzle
```

See the [repository README](https://github.com/velajs/crud#readme) for the full guide.

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

## Custom adapter migration

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

## Request scopes and cursor migration

Custom adapters must implement `requestScope(fn, context)` separately from
`transaction(fn, context)`. Read, list, search, aggregate, and export use ordinary
request scopes; operations needing rollback use transactions. Both receive the
trusted request tenant. A request scope may internally open a transaction when
needed for database session isolation.

Cursor pagination validates versioned tokens at the engine boundary and adds
all primary keys after the configured cursor field. Ties no longer skip rows.
The existing next-only ascending cursor ordering and offset sorting remain.
Null cursor values sort first; compound tokens retain scalar/date types and
Unicode. Invalid, old scalar, wrong-field, and wrong-type tokens fail with 400.
Clients must restart pagination after this migration.

Adapters receive `options.keyset` (fields, direction, decoded boundary), never
an unvalidated client token. Custom adapters must order and compare the full
tuple. Arbitrary read policies paginate only authorized rows and use the same
tuple ordering, retaining tenant-scoped totals.

## License

MIT
