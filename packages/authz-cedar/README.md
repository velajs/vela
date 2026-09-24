# @velajs/authz-cedar

Optional Cedar authorization for Workers. Ordinary `@velajs/authz` users do not
load this package or its WASM. No NestM runtime dependencies or Node compatibility
flag is required.

```ts
import { createCedarEngine, defineVocabulary, t, entity } from '@velajs/authz-cedar';
import { cloudflareCedar } from '@velajs/authz-cedar/cloudflare';
import { D1PolicyStore } from '@velajs/authz-cedar/d1';

const vocabulary = defineVocabulary({
  namespace: 'App',
  entities: { User: {}, Document: { attrs: { owner: t.string() } } },
  actions: { read: { principal: ['User'], resource: ['Document'] } },
});
const engine = createCedarEngine({ vocabulary, binding: cloudflareCedar(), store: new D1PolicyStore(env.DB) });
const scope = { application: 'files', environment: 'production', tenantId: tenant.requireTenantId() };
const decision = await engine.check({
  scope, principal: { type: 'User', id: userId }, action: 'read',
  resource: { type: 'Document', id: file.id }, context: {},
  entities: [entity(vocabulary, 'Document', file.id, { attrs: { owner: file.owner } })],
});
if (!decision.allowed) throw new Error('Forbidden');
```

`/cloudflare` statically imports the packaged WASM module. Wrangler handles the
asset. Other Web runtimes call `initializeCedar(compiledWebAssemblyModule)`
explicitly. Only immutable executable WASM is shared; create an engine per
application/environment. Compiled policy slots have a bounded cache (32 by
default), keyed by application, environment, tenant and authoritative revision.
Call `dispose()` when retiring an engine. The WASM adds approximately 4.11 MiB raw
(1.37 MiB gzip) before application code; account for your Worker bundle limit.

## Policies and query plans

`engine.save(scope, { policies, templates?, links? }, expectedRevision, audit)`
validates policies against the typed vocabulary and commits an atomic revision
and audit. `null` creates a scope; updates require its current revision. Only
trusted administrative code should call it: the storage API does not authorize
administrators. Templates may bind principal/resource slots, and entity builders
support hierarchy parents. Every check/plan reads the authoritative policy store;
a missing scope denies and store failures propagate. Entity providers run for
each operation, without a shared grant cache.

```ts
import { cedarCrudPlan } from '@velajs/authz-cedar/plan';
const plan = await engine.plan({ scope, principal, action: 'read', resourceType: 'Document', context: {}, entities });
const authorization = cedarCrudPlan(plan, {
  resourceType: 'Document', id: 'id',
  attributes: { owner: { field: 'owner', kind: 'string' } },
});
// Return authorization from a CRUD resource's async authorization(context, verb).
```

The exact plan compiler preserves permit/forbid precedence and supports mapped
scalar comparisons, sets of scalar constants, Boolean composition, guarded
optional attributes, type tests, string patterns, and hierarchy membership.
`compileCedarSql(condition, mapping, 'sqlite' | 'pg')` returns parameterized SQL
for direct drivers. `cedarCrudPlan` produces the same structured predicates used
by CRUD before pagination, totals, aggregates, exports, and relation loading.

Map optional absent Cedar attributes to SQL NULL (Cedar has no null value).
Required attributes must satisfy the vocabulary in persisted rows. Longs must be
safe JavaScript integers. String storage must preserve exact case and Unicode;
use deterministic/binary collations and exclude embedded NUL in SQLite pattern
columns. The hierarchy callback must return authoritative descendant-or-self IDs
for the current operation (at most 1,000). It is never a cache invalidation hook.
Unmapped attributes, unsupported expressions/extensions, inexact approximations,
and absent hierarchy mappings throw before a CRUD query is issued.

Inspect the plan's diagnostics and decision diagnostics; `onDecision` supports
application logging. Erroring policies fail closed, including erroring forbids.
Low-level AST utilities are available at `/plan`, vocabulary authoring at
`/vocabulary`, and the memory store/oracle helpers at `/testing`.

## Persistence and Vela

- `/d1`: `D1PolicyStore`, `policySqliteSchema`; primary reads and atomic batches.
- `/postgres`: `PostgresPolicyStore`, `policyPostgresSchema`; primary cache-disabled
  Hyperdrive/client connections and single-statement revision/audit commits.
- `/durable-objects`: `DurableObjectPolicyStore.migrate()`; object-local SQLite.
- Root `MemoryPolicyStore`: instance-owned tests and prototypes.

`CedarModule.forRoot({ authorize, auditModules })` from `/vela` installs the
resource-aware guard. Apply `@RequireResource({ action, resourceType, idParam })`
or `@CedarPublic()` to handlers/classes. The callback receives verified identity
and execution context, resolves authoritative resource entities, and calls the
engine. `auditCedarRoutes([Module])` rejects undeclared routes in selected modules.
Auditing is opt-in; unaudited modules keep existing authorization behavior.
Authentication/tenant guards must run before the Cedar guard when its callback
requires a tenant. Queue/socket adapters must supply verified identities explicitly.
If authentication or tenant admission uses controller/route guards, set
`globalGuard: false` and apply `@UseGuards(AuthenticationGuard, TenantGuard, CedarGuard)`
in that order. Global guards otherwise run before route guards. Keep the default
global Cedar guard when authentication and tenant admission already run upstream.

The package includes NestM BSD-licensed adaptations and unmodified Apache-licensed
Cedar WASM; see `THIRD_PARTY_LICENSES`.
