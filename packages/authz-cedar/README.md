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
resource-aware `CedarGuard` as a global guard in the `authorize` phase, so it
runs after global authentication and tenant admission whatever the import order.
Apply `@RequireResource({ action, resourceType, idParam })` or `@CedarPublic()`
to handlers/classes. The callback receives verified identity and execution
context, resolves authoritative resource entities, and calls the engine.

Application routes that carry neither declaration are denied (403) by
default; `undeclared: 'allow'` lets them through. `undeclared` and `guard` shape
the module, so `forRootAsync` takes them beside its factory. The global guard covers
every application route, including routes in modules that do not import
`CedarModule` (they use the installing module's policy) and whether or not it
is registered with `isGlobal`. An integration package's own controller opts out
with `SkipGuardPhases(['authorize'])` from `@velajs/vela/module-kit`, as the
Better Auth handler, the storage controllers and the GraphQL endpoint do;
`CedarGuard` declares `static readonly skippable = true` for this. Generated
CRUD controllers declare their policy through the resource's `decorators` and
`endpointDecorators` (`[RequireResource({ ... })]`, `[CedarPublic()]`). A
route-level `CedarGuard` in a module that cannot see `CedarModule` denies.
`auditCedarRoutes([Module])` (or `auditModules`) rejects undeclared routes in
selected modules at startup. Queue/socket adapters must supply verified
identities explicitly. To order a fully route-level pipeline yourself, pass
`guard: 'none'` and apply `@UseGuards(AuthenticationGuard, TenantGuard, CedarGuard)`
in that order: global guards run before route guards.

Each `guard: 'global'` registration installs its own global `CedarGuard`,
including each keyed instance (`forRoot({ key, ... })`), and every installed
guard runs on every application route. The installed guard authorizes through
the `CedarModule` the route's module sees, so one global installation serves
every module: when several modules register their own authorizer, give each
registration its own `key`, keep `guard: 'global'` on one and pass
`guard: 'none'` on the others.

The installed guard also runs wherever the application's global guards run outside
controller routes: on WebSocket gateway messages, on the check before each push to a
socket (with the gateway class), on the reserved `$live` frames that subscribe to live
queries (with the framework's `LiveEngine` class) and on RPC procedures. Under the
default deny, an undeclared gateway message answers an `exception` frame, pushes are
dropped, `$live` frames get no reply and an undeclared RPC procedure answers 403.
Declare `@RequireResource()` or `@CedarPublic()` on gateway classes and handlers and on
RPC providers and procedures; only a declaration on the gateway class also admits its
pushes. No declaration reaches `$live` frames: with live queries, set
`undeclared: 'allow'` or pass `guard: 'none'`. Supply `identity` to authorize socket
contexts against a declared resource.

The package includes NestM BSD-licensed adaptations and unmodified Apache-licensed
Cedar WASM; see `THIRD_PARTY_LICENSES`.
