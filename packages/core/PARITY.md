# Parity ledger vs hono-crud 0.13

The native engine targets behavior parity with hono-crud 0.13 (its conformance
suite is the spec). This ledger tracks every INTENTIONAL deviation and deferred
gap so nothing reads as "covered" when it isn't. Update it whenever a
divergence is added or closed.

## Deviations (by design)

- **`RelationConfig.model` → `target`** — relations reference registry keys via
  `target`; the registry rewrites it to the sibling's `tableName`.
- **`timestamps` default ON** (`{ createdAt: 'createdAt', updatedAt: 'updatedAt' }`)
  — hono-crud defaulted OFF. Revisit if conformance managed-fields cells argue
  otherwise (guard idea: only stamp fields present in the model schema).
- **`defineModel` normalizes** to a flat resolved `Model` (softDeleteField /
  tenantField / timestamps resolved); `defineModels` returns normalized models.
- **`id:'database'` gating** is the `databaseGeneratedId` capability flag, not
  an adapter-kind string.
- **Tenant-field exclusion centralized** in `getManagedInputExclusions` (was
  ad-hoc in the create endpoint).
- **`beforeUpdate(ctx, patch, prior)`** — adds the `prior` snapshot (additive).
- **`beforeDelete(ctx, prior)`** — receives the resolved row, not the lookup id
  string (behavioral change for id-string consumers).
- **`afterList(ctx, page)`** — receives the full `Page` (rows + result_info),
  not the bare items array.
- **Policy evaluators are orthogonal primitives** — the kernel must compose
  filter → mask (list) and canRead → 404 → mask (read); hono-crud fused them.
- **Malformed cursors fail loud** at the engine parse boundary
  (`InputValidationException`); adapters keep the lenient start-from-beginning
  fallback as defense in depth.
- **`versioning`/`audit` model flags are booleans** (config objects may return
  at M5 when stores land).
- **`searchFields` ride on `ListOptions`** (engine-injected) so adapters stay
  configuration-free.

## Deferred gaps (planned, not yet built)

- **Aggregate**: CLOSED (M4). Full multi-aggregation parity landed — `?count=*`,
  `?sum=field`, `?avg=field`, repeated ops on multiple fields, `getAggregateAlias`
  camelCase keys (`sumAmount`, `countDistinctTag`, bare `count` for `COUNT(*)`),
  multi-`groupBy`, `having[alias][op]=value` (eq/ne/gt/gte/lt/lte), `orderBy`/
  `orderDirection`, and group `limit`/`offset` (+ `defaultLimit` 100 / `maxLimit`
  1000). `computeAggregateFallback` mirrors hono-crud `computeAggregations`; the
  response is `{ values }` (ungrouped) or `{ groups, totalGroups }` (grouped).
  Type changes: `AggregateSpec` extended ADDITIVELY (optional `aggregations`,
  `having`, `orderBy`, `orderDirection`, `limit`, `offset`; `operation`/`field`
  retained as the legacy single-op head); `AggregateResult` REPLACED (`{ buckets }`
  → `{ values?, groups?, totalGroups? }`) — a flagged non-additive change, safe
  because no in-repo adapter implemented `aggregate`. Residual (minor): aggregate
  WHERE uses the full `FilterCondition[]` bracket-operator pipeline (richer than
  hono-crud's equality-only filter Record — additive), and `?withDeleted` is
  honored on the fallback path (via `adapter.list`) but not plumbed into
  `AggregateSpec` for a hypothetical native adapter.
- **Nested-write schema merging**: `deriveCreateSchema` does not merge relation
  write shapes into the create body schema (no `nestedWrites` flags on
  `RelationConfig` yet). M4.
- **Per-relation include scoping** (`RelationConfig.scope`): dropped from the
  model layer; `RelationLoadScope` covers tenant + soft-delete owner-scoping at
  the loader. Revisit with the relation conformance cells (M3).
- **Not ported in release 1** (goes in the CHANGELOG too): cache, rate-limit,
  idempotency, MCP, swagger/scalar UIs, prisma adapter, api-version, health,
  logging middleware.

## Conformance suite (hono-crud parity harness)

The hono-crud conformance harness + group-1 cells are ported at the workspace
root (`tests/conformance/`), run via `pnpm test:conformance`. Status of the
group-1 cells against the native engine:

- **soft-delete-lifecycle**: delete/hide/list assertions PASS. The three
  `restore` assertion blocks are `test.skip`ped with `// TODO(M4): restore verb`
  — `POST /:id/restore` is gated out of `IMPLEMENTED_ENDPOINTS` (verb-table.ts)
  until the restore executor lands (M4). No engine bug; a known deferral.
- **managed-fields**, **pagination**, **filter-operators**: PASS verbatim (no
  gaps). No PARITY-GAP surfaced during the port.
- **Deferred cells (NOT ported)**: `unique-conflict` needs unique-constraint
  enforcement (the memory adapter has no constraint surface and the model layer
  has no unique declaration — the source already skips it on the memory leg);
  `etag-concurrency` needs ETag/If-Match support (no `etagEnabled` read/update
  path in the native engine yet). Both revisit when those capabilities land.

### Tenant cells (M3 gate)

- **tenant-scoping**: PASS verbatim. `multiTenant()` mounted upstream (outer
  Hono wrapper, path-scoped to `/tenant-items`); create-stamp + read/list/
  update/delete tenant equality + `400 TENANT_REQUIRED` all hold. Harness note:
  the outer Hono needs an `onError` that renders `CrudException` — Vela's
  `HttpException` is not a Hono `HTTPException`, so a bare outer app swallows a
  middleware-thrown TENANT_REQUIRED into an empty 200. In a real deployment the
  resolver registers through Vela's pipeline (which renders it natively).
- **relation-scoping**: PASS verbatim (all three assertions, incl. the
  soft-deleted-parent one). The `excludeDeletedField` gap below is CLOSED.
- **batch-tenant-scoping / extended-verb-tenant-scoping**: ported at the M4 gate
  (below).

**PARITY-GAP (CLOSED) — relation loader `excludeDeletedField` not wired.**
Was: `kernel/verbs.ts` `attachIncludes` forwarded only `{tenantField,
tenantValue}`, so a soft-deleted parent stayed embedded via `?include=parent`.
Fixed (the load scope now carries `excludeDeletedField`); the relation-scoping
soft-deleted-parent assertion is un-skipped and green.

### Extended-verb cells (M4 gate)

All 18 non-version verbs are live, so five more cells are ported (run via
`pnpm test:conformance`):

- **upsert-restore**: PASS verbatim. `/items` mounts `upsert: { keys: ['email'] }`;
  single upsert + batchUpsert both match-and-restore a soft-deleted row (same id,
  `created: false`, `deletedAt` cleared). Synthesis path (memory declares
  `restore` but not `upsert`).
- **bulk-patch**: PASS. Assertions verbatim; only the TRANSPORT is adapted — the
  filter moves from the query string (`?role=guest`) to the request body
  (`{ filter: { role }, data: { age } }`), the engine's deliberate deviation
  (see batch.ts). `?dryRun=true` stays a query param; flat `{ success, matched,
  updated, dryRun }` body unchanged.
- **batch-tenant-scoping**: PASS verbatim (capability guard dropped for the
  single memory leg). Cross-tenant batchDelete/batchUpdate/batchRestore fall to
  `notFound`; own-tenant ops succeed; no-header batch → 400 TENANT_REQUIRED.
- **extended-verb-tenant-scoping**: PASS. Assertions verbatim; the bulkPatch leg
  uses the body-filter transport. aggregate (`?count=*`, `?count=*&groupBy=role`),
  search (`?q=`, `searchFields: ['name']`), export (`?format=json`), and
  bulkPatch are all tenant-scoped; each 400s TENANT_REQUIRED without a header.
  Note: `search`/`export` do not wire `?include=`, so the include-scoping
  assertions hold trivially (the foreign parent is never embedded → `null`).
- **cursor-pagination**: all three tests PASS (exact cursor-mode result_info,
  the cursor WALK order, and the offset-mode-on-a-cursor-endpoint fallback).

**PARITY-GAP (CLOSED) — memory cursor `result_info.page` was `1`, not `0`.**
Was: `memoryAdapter.list`'s cursor branch hardcoded `page: 1` while the
engine's own `buildCursorPageInfo` (query/pagination.ts) and the
cursor-pagination cell pin the next-only envelope at `page: 0` (Stripe-style).
Fixed (the memory cursor branch emits `page: 0`, memory/src/adapter.ts —
drizzle's cursor branch agrees); all three cursor tests run un-skipped.

**Deferred (need unbuilt families — NOT ported):**
- **finalize-pipeline**: needs a model-level `serializationProfile`
  (`exclude: ['age']`) to strip a field from every response. The native engine
  has no `serializationProfile` (computed fields exist and would satisfy the
  `nameUpper` half, but not the `'age' in record === false` half). Revisit if a
  serialization-profile authoring surface lands.
- **transactional-hooks**: needs a hook-recorder harness + a `/hook-items`
  controller sharing the `/items` table, AND diverges on the before-hook data
  shape — the native engine stamps managed fields (incl. the generated `id`)
  BEFORE `beforeCreate`, so `before.data.id` is defined where the cell asserts
  `toBeUndefined()`. The noop-tx-sentinel semantics exist, but the create-hook
  data-shape assertion cannot pass verbatim. Defer.
- **events / encryption**: the engine has no event-emission or field-encryption
  family yet (coordinator-confirmed). Defer.
- No dedicated export/import conformance cell exists in the source; export (JSON
  leg) is covered by the extended-verb-tenant-scoping cell.

## Extended-verb deviations (M4 families)

- **restore/clone run hookless** (no single-verb hooks upstream either);
  import runs without per-row lifecycle hooks (hono-crud had dedicated import
  hooks) — consistent precedent.
- **upsert body validates the FULL createSchema**, not hono-crud's
  keys-required/rest-optional partial shape.
- **clone.fieldsToReset**: CLOSED — first-class `clone?: { fieldsToReset?:
  string[] }` on `ResourceConfig` and `CrudConfig`; the file-local cast in
  the clone executor is gone.
- **bulkPatch filters arrive in the request BODY** (`{ filter, data }`), not
  the query string; same flat success body as hono-crud.
- **Per-item batch hook errors follow the hook mode** (sequential aborts +
  rolls back) instead of hono-crud's per-item error bucket + stopOnError;
  only notFound ids drive 207. batchCreate is all-or-nothing (201).
- **batchRestore absent-support is a loud 500 CONFIGURATION_ERROR** (matches
  single restore), not hono-crud's 400 SOFT_DELETE_NOT_ENABLED.
- **Hardening beyond hono-crud** (deliberate): search + export apply
  read-policy row filtering + field masking; import injects + scopes the
  request tenant; search's short `q` is VALIDATION_ERROR (was INVALID_QUERY).
- **AggregateResult reshaped** to `{values?, groups?, totalGroups?}` (no
  in-repo adapter implemented the old `{buckets}` shape); constraint→409
  mapping for clone/upsert remains an adapter/errorMappers concern.
- **Drizzle `restore`**: CLOSED (M7). Was: "will need `restore` — loud
  ConfigurationException until then". Shipped: capability declared + implemented
  in drizzle/src/adapter.ts, exercised by the drizzle adapter tests and the
  soft-delete-lifecycle conformance cell on the drizzle leg.

## Versioning + Audit families (M5)

Native rewrite of hono-crud 0.13's versioning (`versioning/index.ts` +
`endpoints/version-history.ts`) and audit (`audit/index.ts`) families. Both
stores are **DI seams decoupled from the data adapter**: `VersioningStore` /
`AuditStore` interfaces + `MemoryVersioningStore` / `MemoryAuditStore` on the
`@velajs/crud/versioning` + `@velajs/crud/audit` subpaths. Provided per-resource
(`versioningStore` / `auditStore` on `ResourceConfig` / `CrudConfig`) or as a
`CrudModule.forRoot({ versioningStore, auditStore })` default (resolved in
`stamp-routes` `resolveResource` + `forFeature`, mirroring `CRUD_DEFAULT_ADAPTER`).

### Pinned semantics (from hono-crud sources/tests)

- **Store-seam renames** (shape preserved): `VersioningStorage` →
  `VersioningStore` with `store→save`, `getByRecordId→list`, `getVersion→get`,
  `getLatestVersion→latest` (+ optional `prune`/`deleteAll`). Per-`(tableName,
  recordId)` keying, newest-first ordering, `latest` = max stored version or 0
  (`versioning-store.test.ts`, `versioning.test.ts`). Audit fuses hono-crud's
  `AuditLogger` (entry building, now in `kernel/capture.ts`) + `AuditLogStorage`
  (persistence) into one seam: `log` / `logBatch` / `query`.
- **Snapshot timing = PRE-mutation, inside the tx, before the write.** On
  UPDATE the pre-update record is snapshotted and the row's version field is
  incremented (`versioning.test.ts` "save version before update": snapshot =
  pre-update state, row → v2). `captureVersion` (kernel/capture.ts) is the sole
  placement.
- **Version numbering:** the stored entry's `version` is the record's CURRENT
  version field (or 0); the number stamped on the write is that **+ 1** — exactly
  hono-crud `VersionManager.saveVersion` ("store the version BEFORE the update,
  return the new one"). `version` column fixed to `'version'` (the model flag is
  a boolean, so no config-object field-name override — see M5 note below).
- **versionHistory** (`GET /:id/versions`): `?limit` (1..100, default 20),
  `?offset` (≥0). Body `{ versions: [...newest-first], totalVersions }` where
  `totalVersions = latest` (highest stored version).
- **versionRead** (`GET /:id/versions/:version`): `:version` path param (positive
  integer; non-int → 400 VALIDATION_ERROR); missing snapshot → 404. Body is the
  bare `VersionEntry`.
- **versionCompare** (`GET /:id/versions/compare?from=&to=`): **query** params
  `from`/`to` (positive integers, both required → 400 if missing/invalid). Body
  `{ from, to, changes }`; a **missing version yields `changes: []` (no 404)** —
  parity with `VersionManager.compareVersions`. `?from`/`?to` were pinned as
  query params (not path), matching hono-crud's `getQuerySchema`.
- **versionRollback** (`POST /:id/versions/:version/rollback`): reads the target
  snapshot (404 if absent), writes its historical `data` back via
  `adapter.update` inside the tx, and returns the **resource envelope of the
  rolled-back row** whose `version` = currentVersion + 1 (`versioning.test.ts`:
  rollback to v1 of a v3 row → `title: 'Title v1'`, `version: 4`).
- **Tenant/owner scope:** every version verb resolves the parent record through
  the tenant-scoped `buildLookup` first (soft-delete-inclusive) — a foreign or
  missing record is 404, so version data never leaks
  (`versioning-tenant-scope.test.ts` parity).
- **Audit entries** (who = `userId` / what = action + record/previousRecord +
  `changes` / when = `timestamp`) are written **AFTER the mutation commits**;
  batch mutations use `logBatch`. `changes` via `calculateChanges` (ported
  verbatim, JSON-structural diff) on update/upsert. Wired into create, update,
  delete, restore, upsert, and all five batch verbs.
- **Definition-time loud errors:** `model.versioning` without a `versioningStore`
  (or `model.audit` without an `auditStore`) throws `ConfigurationException` at
  `defineResource` — hono-crud surfaced this only at request time.

### Deliberate deviations (tracked)

- **Versioning snapshots on UPDATE + DELETE + ROLLBACK.** hono-crud only ever
  calls `saveVersion` in `update.ts` (verified: `saveVersion` has one caller).
  The native engine additionally snapshots the pre-delete and pre-rollback state
  (per the M5 design constraint / deliverable "snapshot capture on update/delete").
  No hono-crud versioning test or conformance cell contradicts this (versioning
  is gated behind `model.versioning`, off by default → no conformance cell).
- **Rollback numbers the new version as `currentVersion + 1`** (symmetric with
  update: it captures the pre-rollback state like an update would), where
  hono-crud uses `getLatestVersion() + 1` **without** a pre-rollback snapshot. In
  the pinned rollback test the two coincide (both → 4) because the seeded latest
  version equals the live row's version; in a natural update-only history they
  can differ.
- **Audit is AWAITED post-transaction**, not fire-and-forget via
  `runAfterResponse` — a caller (and a test) observes the entry with no timer.
  Safe: the write already committed.
- **`model.versioning` / `model.audit` stay booleans** (PARITY.md M5 note): no
  config object yet, so `version` field = `'version'`, `excludeFields = []`, no
  `maxVersions` pruning at capture time, and audit records every wired mutation.
  The store `prune`/`deleteAll` methods exist for implementer parity but the
  engine never calls them (no `maxVersions`).
- **Version-verb "not enabled" / "store missing" → `ConfigurationException`
  (500)**, not hono-crud's `VERSIONING_NOT_ENABLED` (400). Both are unreachable
  through a stamped route (gated on `model.versioning`; store presence affirmed
  at definition); this is defense for direct `resource.execute('version*')`
  callers — consistent with the restore verb's 500.
- **HTTP seam fix:** `request-flow.ts` `buildEngineRequest` now forwards the
  `params` map (previously dropped), so the `:version` path param reaches the
  version verbs. `stamp-routes` was not restructured (VERB_SHAPES already stamps
  id+version).

## Drizzle adapter (M7)

- **Capability honesty over hono-crud parity**: the drizzle adapter does NOT
  declare `upsert` (the engine's find→restore/update→create synthesis runs in
  a real transaction — atomic, exact `created` flag; hono-crud used ON
  CONFLICT) nor `nativeSearch` (hono-crud's drizzle search was LIKE-based; the
  engine fallback is equivalent).
- **sqlite (libsql) fully exercised** — 14 unit tests + the full 38-cell
  conformance leg. pg/mysql branches are written per hono-crud (POSITION/
  LOCATE substring predicates, mysql insertId without RETURNING) but UNTESTED.
- libsql caveat: transactions open a new connection, so `:memory:` databases
  are per-connection — tests use file-backed temp DBs.
- Workers-pool conformance leg DEFERRED: the drizzle leg cannot run in
  workerd (libsql client), and the edge guarantee is already machine-verified
  by the openness/edge import audits over product sources. Revisit if a
  D1-flavored adapter lands.

## Gaps surfaced by the erpos migration (2026-07-09, erpos PR #315)

- **Per-endpoint guard seam**: CLOSED (1.19). Was: hono-crud's `registerCrud`
  accepted `endpointMiddlewares` per verb; the native config had no
  equivalent, so erpos's `guardsFromAcl` per-verb feature gating couldn't be
  wired on headless resources. Shipped: `guards?:
  Partial<Record<CrudEndpointName, GuardType[]>>` on `CrudConfig`, stamped per
  synthesized handler via vela's public `UseGuards` in `stampCrudRoutes` —
  covers `@Crud` controllers and `forFeature` resources; `@Override`'d
  endpoints keep their config guards (AND with their own); runs after global +
  class-level guards. Programmatic `resource.execute` is intentionally
  unaffected. Proven by the "per-endpoint guards (config.guards)" tests in
  crud-http.test.ts. Scope note: guards only — per-endpoint
  middleware/interceptors/pipes remain unported.
- **Tenant into `adapter.transaction()`**: CLOSED (1.19). Was: SQL setups
  using RLS GUCs (`SET LOCAL app.tenant_id`) couldn't see the request tenant
  at tx open. Shipped: `transaction(fn, ctx?: TransactionContext)` — the
  engine passes `{ tenantId: req.vars.tenantId }` at every executor tx-open
  site (`txCtx` in kernel/verb-helpers.ts), and the drizzle adapter adds an
  `onOpenTransaction(tx, ctx)` config seam for issuing the `SET LOCAL`.
  Engine WHERE-scoping remains the primary isolation layer; RLS is opt-in
  defense-in-depth. Proven by verbs.test.ts "transaction context", drizzle's
  "forwards TransactionContext to onOpenTransaction", and the memory
  signature-widening test.

## resolveSchema wired (1.18.1)

- `Model.resolveSchema` (per-tenant schemas — tenant custom fields) is now
  INVOKED: every body-validating verb (create/update/upsert/clone/batch*/
  bulkPatch/import) resolves the tenant schema per request and re-derives the
  body schema (`createSchemaFor`/`updateSchemaFor`); explicit `dto` overrides
  still win. Gap found by the erpos migration (custom-fields regression).
  Resolution is per-request, uncached (hono-crud parity) — resolvers may
  cache internally.

- **`id: 'client'` PK strategy** (erpos round 2) — the engine strips PKs from
  every create body (both static derivation and the resolveSchema path), so
  callers with client-generated UUIDs need a capture-guard workaround
  (erpos `ClientPkCaptureGuard`). Candidate: a model `id: 'client'` strategy
  that keeps the PK in the create body schema and skips generation. 1.19.
- **Sub-app onError note** (erpos round 2, vela-side) — hono `.route()`
  sub-apps with their own error handler render locally; since vela 1.11's
  pipeline rewrite, a parent app's `onError` no longer covers merged sub-app
  routes. Not a crud issue; consumers mounting sub-apps alongside crud
  controllers should propagate their error renderer (erpos intercepts
  `hono.route` in bootstrap). Consider a vela docs note or an opt-in
  fall-through.
