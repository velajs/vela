# @velajs/crud-drizzle

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [a2d2692]
  - @velajs/crud@2.0.0

## 1.26.0

### Minor Changes

- 2addbe3: Prepare typed, authenticated insert commands for native atomic batches, including durable event admission alongside business inserts.
- 2addbe3: Bind version history and opt-in transactional audit stores to the exact database owner, trusted tenant and current CRUD transaction. Failed writes and awaited hooks roll back snapshots and audit entries; same-owner native stores can join through a checked transaction binding.
  
  Versioned resources now require transaction-aware persistence and a unique version identity constraint. Drizzle audit tables require an explicit tenantNamespace migration; legacy unattributed records remain excluded. Preserve default best-effort post-commit auditing and D1 precomputed atomic auditing. Add transactional memory history stores and validate audit queries and history uniqueness.

### Patch Changes

- Updated dependencies [2addbe3]
  - @velajs/crud@1.27.0

## 1.25.0

### Minor Changes

- 56e472e: Add optional atomic precomputed write batches with typed results, exact database ownership checks, and conditional audit commands. Drizzle supports native D1 batches and asynchronous SQLite/PostgreSQL transactions. CRUD resources can opt into atomic metadata-only auditing for core mutations; unsupported snapshot, hook, store, and adapter configurations fail before writes. Existing post-commit auditing remains the default.

### Patch Changes

- Updated dependencies [56e472e]
  - @velajs/crud@1.26.0

## 1.24.1

### Patch Changes

- 1ee888a: Budget D1 statement parameters before queries and writes, and chunk relation
  includes while preserving tenant, authorization and soft-delete predicates.
  Use bounded IN predicates to avoid large OR expression trees. Direct adapter
  operations now enforce the active native-handle scope ownership contract.
  Prepare statements once to preserve generated defaults through inspection and
  execution, including atomic batches, and accept schema-aware D1 handles.
- a66a3cb: Add typed named database registrations, explicit module/resource routing, database-qualified resource identities and isolated default stores. Preserve single-database authoring and native handle inference.

  Add explicit same-owner resource transaction composition with tenant/lifetime checks, rollback after caught operation errors, draining of accepted work, and ordered outer-commit notifications. Validate native Drizzle scopes and preserve genuine Durable Object transactions. D1 callbacks, cross-database atomicity and composition with non-transaction-aware versioning stores fail explicitly.
- Updated dependencies [6588211]
- Updated dependencies [a66a3cb]
- Updated dependencies [de4e57e]
- Updated dependencies [cc0dcfd]
  - @velajs/crud@1.25.0

## 1.24.0

### Minor Changes

- fe7587f: Add Standard Schema validation and operation contracts, authoritative tenant admission and audited persistence, optional Cedar authorization with exact query plans, and Web Crypto envelope/field/file encryption. Complete compound CRUD identifiers, parent scopes, structured predicates, signed cursors, page projections and post-commit delivery. Add transactional memory and Durable Object SQLite adapters, with D1/Workers and PostgreSQL conformance coverage.

### Patch Changes

- Updated dependencies [fe7587f]
  - @velajs/crud@1.24.0

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/crud@1.22.1

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/crud@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/crud@2.0.1

## 2.0.0

Typed Drizzle adapter and native D1 conformance. Unsupported D1 callback transactions fail before side effects.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

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
  tenant custom-fields regression found by a downstream migration.

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
    events/webhooks, field encryption, serialization profiles.
