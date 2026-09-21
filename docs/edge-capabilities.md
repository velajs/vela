# Tenant-aware edge applications

Vela's optional [tenant](../packages/tenant/README.md),
[Cedar authorization](../packages/authz-cedar/README.md),
[encryption](../packages/crypto/README.md), and
[Durable Object CRUD adapter](../packages/crud-durable-objects/README.md) share Web
API contracts. D1 and PostgreSQL integrations are independently imported. No
NestM runtime, ORM façade, or mandatory Node compatibility flag is introduced.

## Validation and model contracts

`defineDto` and `ValidationPipe` accept Standard Schema v1, including async
validation and transformed output. Existing parser DTOs and `ZodValidationPipe`
remain supported. Standard issues become HTTP 400 responses with normalized
paths; exceptions thrown by a validator remain server errors. Generated CRUD
routes consume an unchanged pipe result once, avoiding duplicate transforms.
Middleware changes to that result require validation again.

Standard JSON Schema is a separate conversion interface. `defineDto` accepts
`jsonSchema` or `schemaConverter(direction)` when a validator has no converter.
OpenAPI uses input schemas for requests and output schemas for responses; a DTO
with different shapes receives distinct components. Existing Zod authoring and
inference remain available.

```ts
import * as v from 'valibot';
import { defineStandardModel, defineCrudContracts } from '@velajs/crud';
const row = v.object({ id: v.string(), amount: v.number() });
const contracts = defineCrudContracts({
  id: v.string(),
  create: v.object({ id: v.string(), amount: v.pipe(v.string(), v.transform(Number)) }),
  update: v.partial(row),
  response: row,
});
const invoice = defineStandardModel({
  name: 'invoice', tableName: 'invoices', schema: row,
  fields: { id: { type: 'string' }, amount: { type: 'number' } },
  id: 'client', timestamps: false, contracts,
});
```

`ContractInput<S>` and `ContractOutput<S>` preserve each concrete schema's types.
Contracts independently describe identifiers, create/update/upsert/clone inputs,
persisted rows and response rows. Standard models require explicit create/update
schemas and persistence/filter metadata; no generic partial/omit operation is
invented. The row schema validates database output. Response contracts run after
masking and response transforms. Write hooks still receive persistence rows.
Zod models normalize field metadata automatically. The existing internal Zod
field mechanics remain an implementation detail of the CRUD engine.

## Scoped CRUD operations

- Supply complete compound IDs as `{ keyA, keyB }` for headless point operations
  and batch IDs. Generated point routes include every primary-key parameter.
  Configure every adapter's `primaryKeys` consistently with the model.
- `collection: { parents: { projectId: 'projectId' } }` derives a mandatory
  persistence predicate from the parent route parameter. Queries and writes
  cannot escape or overwrite this scope. Numeric parent fields use normalized
  field metadata.
- `authorization: async (context, verb) => plan` returns `allow`, `deny`, or a
  structured `conditional` predicate. Boolean composition is validated before
  querying; adapters must advertise support. Relations can provide their own
  `response.authorization(context, verb)`; nested writes require atomic
  predicate support. Multi-action nested operations use the intersection of
  their target predicates. A relationship still joins on its declared single
  local/foreign column; model compound IDs do not invent compound joins.
- `pagination.cursor.codec` accepts an asynchronous codec. `hmacCursorCodec`
  uses HMAC-SHA-256 keys (at least 256 bits), key rotation and expiry, binding
  resource, full ordering, tenant and parent collection. Construct keys per
  environment. Unsigned existing cursors remain the default for compatibility;
  enabling a codec rejects old unsigned tokens.
- `projectPage(rows, context)` computes additive fields for a page in one call,
  before masking. It cannot overwrite persisted fields or change row count.
- `afterCommit(event)` runs only after the adapter's scope succeeds. Delivery
  errors go to `onAfterCommitError` and never turn an already committed write
  into a reported rollback. Legacy transactional hooks retain their behavior.
  Bulk adapters returning only counts emit `updateMany` events. This hook is
  best-effort delivery, not a durable outbox.
- Native scoped upserts must advertise `scopedUpsert`. Conflict updates preserve
  all primary keys and apply tenant/parent/authorization predicates. D1 uses a
  precomputed atomic batch and rejects callback-dependent upsert hooks.
  Set `atomicUpsert: true` on Drizzle/Durable Object adapters and provide real
  database unique constraints for every upsert conflict target. The default
  preserves the existing transaction-based matching behavior.
- `MemoryStore` + `transactionalMemoryAdapter` provides instance-owned,
  serialized copy-on-write transactions for conformance. The old memory adapter
  remains available with its documented nontransactional behavior.

## Authority and backend boundaries

Authenticate, admit a tenant, resolve authorization, execute scoped persistence,
then explicitly reveal encrypted fields. Each new operation reads authoritative
tenant status and policy revision. An operation already admitted may finish.
Compiled policies may be cached by environment/tenant/revision; mutable entities
and grants remain operation-local unless authoritative versions are available.

D1 uses primary reads, single-statement mutations and precomputed atomic batches;
it cannot execute JavaScript transaction callbacks. PostgreSQL uses real
transactions and optional forced RLS with transaction-local tenant settings.
Hyperdrive admission connections must disable query caching. Durable Objects
provide transactions within the addressed object only. KV/invalidation delivery
is not an authorization consistency mechanism.

See [Standard Schema](https://standardschema.dev/),
[D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
and [Hyperdrive caching](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/).

## Validation

`pnpm verify` includes real workerd D1, Durable Object, Cedar WASM and R2 tests.
Cedar-versus-SQL tests use SQLite and PostgreSQL (PGlite). For the external
PostgreSQL suite, point `VELA_POSTGRES_URL` at a disposable test server and run
`pnpm test:conformance` or `pnpm verify`; the suite creates/removes its own unique
schema and RLS role. The role test requires role/schema creation privileges.
`node scripts/edge-consumer.mjs <artifact-directory>` validates exact packed
archives, optional imports, declarations and Wrangler bundling outside the workspace.
