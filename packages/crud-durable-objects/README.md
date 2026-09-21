# @velajs/crud-durable-objects

SQLite CRUD transactions confined to one Durable Object. Install with
`@velajs/crud`, `@velajs/crud-drizzle`, and `drizzle-orm`.

```ts
import { durableObjectSqliteAdapter } from '@velajs/crud-durable-objects';
const adapter = durableObjectSqliteAdapter({
  storage: this.ctx.storage,
  table: documents,
  primaryKeys: ['tenantId', 'id'],
  atomicUpsert: true, // conflict targets must have a PRIMARY KEY/UNIQUE constraint
});
```

Use inside a SQLite-backed object, after applying application migrations. The
adapter uses Drizzle's native Durable SQLite driver for SQL and the object's
`storage.transaction()` for async CRUD callbacks and hooks. Returning promises
from a synchronous Drizzle transaction is not used. Exceptions roll back local
writes; `afterCommit` callbacks run after storage transaction completion.

The adapter supports compound IDs, structured predicates, scoped native upserts,
relations and normal SQLite CRUD capabilities. Pass every primary key in
`primaryKeys`. Declare a SQLite-backed class migration in Wrangler. Bind object
routing to the canonical tenant/object key and admit tenant authority inside the
operation. It provides no cross-object, R2, queue, or D1 atomicity.

Real workerd conformance lives in `tests/crud/edge-workerd.test.ts` at the monorepo
root. See the [edge capabilities guide](../../docs/edge-capabilities.md).
