# @velajs/crud-drizzle

## 1.19.1

### Patch Changes

- 65a30ed: Modernize the package build, validation, and release toolchain.

## 1.19.0

### Minor Changes

- 68f05e4: ETag/If-Match optimistic concurrency and unique-constraint enforcement
  (hono-crud parity, closing the last two deferred conformance cells).
  `etag: true` on a resource makes reads emit a strong content-hash `ETag`
  (computed→mask→profile representation, stable across `?fields=`) and honor
  `If-None-Match` (304, empty body); updates honor `If-Match` and reject a
  stale tag with 409 CONFLICT (hono-crud's actual behavior — not 412). Model
  `unique` tuples (global scope; soft-deleted rows occupy the slot; null
  values never conflict) require the new `uniqueConstraints` adapter
  capability: the memory adapter enforces natively on create/update, and the
  drizzle adapter translates database unique-violations (sqlite/pg/mysql
  shapes) to 409 `ConflictException` — closing the constraint→409 concern for
  the in-repo adapters.
- 2097825: Thread the request tenant into `adapter.transaction()`. New optional
  `TransactionContext` param (`{ tenantId? }`) is passed by the engine at every
  tx-open site; the drizzle adapter gains an `onOpenTransaction(tx, ctx)` config
  seam so consumers can issue `SET LOCAL <guc> = <tenant>` for Postgres RLS
  defense-in-depth. Additive: adapters and configs that ignore the context are
  unchanged.

### Patch Changes

- 783e415: Recognize Postgres's "duplicate key value violates unique constraint" message
  shape in the unique-violation → 409 translation (previously only the `23505`
  code matched), and exercise the pg dialect end to end via a new PGlite test
  leg (predicates, cursor, restore, nested driver, real-transaction rollback).

## 1.18.1

### Patch Changes

- Wire `Model.resolveSchema` into request-time body validation: every
  body-validating verb now resolves the per-tenant schema and re-derives its
  body schema per request (explicit `dto` overrides still win). Fixes the
  tenant custom-fields regression found by the erpos migration.

## 1.18.0

### Minor Changes

- 7edf218: BREAKING — the engine is rewritten from scratch and the hono-crud dependency is
  removed. `@velajs/crud` is now the native Vela CRUD engine.

  - `@Crud()` stamps REAL controller routes (named routes → `urlFor`, full
    guard/pipe/interceptor pipeline, OpenAPI via the normal controller walk); the
    RouteContributor bridge is gone. Requires `@velajs/vela >= 1.18`.
  - New adapter contract: one plain-object `CrudAdapter` (5 core methods +
    declared capabilities + optional native methods). Adapters:
    `@velajs/crud-memory`, `@velajs/crud-drizzle` (sqlite exercised; pg/mysql
    branches present but untested).
  - All 22 verbs: core five + restore/clone/upsert, batch family + bulkPatch
    (X-Confirm-Bulk), search/aggregate (multi-op with aliases, having, group
    ordering)/export (CSV/JSON)/import, and the four version verbs.
  - Multi-tenant: `multiTenant()` resolver middleware + engine-level scoping +
    the `tenantResolverMounted` fail-fast. Versioning/audit: DI store seams
    (`VersioningStore`/`AuditStore`) with memory + drizzle implementations.
  - Live queries: `live: true` invalidates `crud:<table>` and stamps commit
    headers post-commit/pre-flush.
  - NOT ported in this release: response cache, rate-limit, idempotency, MCP,
    swagger/scalar UIs, prisma adapter, api-version, health, logging middleware,
    events/webhooks, field encryption, serialization profiles. See
    packages/core/PARITY.md for the full deviation ledger.
