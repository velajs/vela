# Typed headless CRUD services

`bindCrudService` gives application services typed access to an existing CRUD
resource. It calls the same engine as HTTP routes: input validation, authorization,
tenant scoping, persisted-row validation, hooks, field masking and response
projection remain in one pipeline. It does not introduce tracked entities or a
second repository implementation.

```ts
import { z } from 'zod';
import { defineCrudContracts, defineModel, defineResource } from '@velajs/crud';
import { bindCrudService } from '@velajs/crud/service';

const row = z.object({
  id: z.string(),
  amount: z.number(),
  tenantId: z.string(),
});
const contracts = defineCrudContracts({
  id: z.string(),
  create: z.object({
    id: z.string(),
    amount: z.string().transform(Number),
  }),
  update: z.object({ amount: z.string().transform(Number) }),
  response: z.object({ id: z.string(), amount: z.number() })
    .transform(({ id, amount }) => ({ id, displayAmount: String(amount) })),
});
const model = defineModel({
  name: 'order',
  tableName: 'orders',
  schema: row,
  timestamps: false,
  id: 'client',
  multiTenant: true,
});
// `adapter` is your existing memory, Drizzle or Durable Object adapter.
const resource = defineResource('orders', { model, adapter, contracts });
const orders = bindCrudService(resource, contracts);

// Pass the admitted request/event tenant context on each call.
const result = await orders.create(
  { id: 'one', amount: '42' },
  { tenant: admittedTenant },
);
result.data.displayAmount; // string; stored `amount` is a number
result.status;             // 201

const page = await orders.list({ per_page: '20' }, { tenant: admittedTenant });
page.data.result;           // projected response records
page.data.result_info;      // existing CRUD pagination metadata
```

Create/update methods accept the contracts' **input** types, including input
that an asynchronous Standard Schema validator transforms. Returned records use
the response contract's **output** type. The facade forwards raw input to the
engine and unwraps its already-validated output; it does not parse a transformed
response again. Define an explicit response contract that describes the result
after field masking and projection. `row` contracts describe persisted data and
are independent of the response shape.

Binding checks schema identity against the compiled resource, including its
optional identifier contract. Pass the same contract instances used to define
the resource. A different schema cannot be used to claim a narrower return type.
`defineStandardModel(...).contracts` can be passed when it contains the required
create, update and response contracts. Composite identifier schemas infer every
required component; identifier inputs must be strings or records of string/number
parts, matching the engine's public identifier representation.

The methods are `create(input, context?)`, `read(id, context?)`,
`update(id, input, context?)`, `delete(id, context?)`, and
`list(query?, context?)`. Results carry `status`, `data` and `headers`; delete data
is `{ deleted: true }`. Exceptions propagate through the existing CRUD error
contract. Conditional reads preserve ETag behavior: narrow `result.status === 200`
before using read data, since a `304` has `data: undefined`.

Context is explicit and is never cached by the service. It includes the existing
request, tenant reader, trusted variables and parent path parameters. Use the
same admitted context that your HTTP/event integration would pass to the resource.
Raw tenant selectors are not authentication. Any transaction context supported
by `EngineRequest` is forwarded unchanged to the resource; database selection and
transaction ownership belong to the database integration.

Register the binding with an ordinary typed Vela provider when DI is useful:

```ts
import { InjectionToken, Module } from '@velajs/vela';

const ORDERS = new InjectionToken<typeof orders>('orders');

@Module({
  providers: [{ provide: ORDERS, useFactory: () => bindCrudService(resource, contracts) }],
  exports: [ORDERS],
})
class OrdersModule {}
```

The typed facade currently requires the default response envelope and rejects
`afterList` hooks because they may replace data after response validation.
Use `projectPage` or `transformList` for projections before the response contract,
or use the existing `resource.execute` API for custom envelopes and post-validation
list replacements. Existing resources and HTTP APIs remain supported.
