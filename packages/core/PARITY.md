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

- **Aggregate**: single-operation `AggregateSpec` only — hono-crud's
  multi-aggregation per query, `having`, group ordering, group pagination,
  `?sum=field` shorthand, and `sumValue`-style aliases are NOT implemented.
  Revisit at M4 (aggregate verb) — full parity requires extending the spec.
- **Nested-write schema merging**: `deriveCreateSchema` does not merge relation
  write shapes into the create body schema (no `nestedWrites` flags on
  `RelationConfig` yet). M4.
- **Per-relation include scoping** (`RelationConfig.scope`): dropped from the
  model layer; `RelationLoadScope` covers tenant + soft-delete owner-scoping at
  the loader. Revisit with the relation conformance cells (M3).
- **Not ported in release 1** (goes in the CHANGELOG too): cache, rate-limit,
  idempotency, MCP, swagger/scalar UIs, prisma adapter, api-version, health,
  logging middleware.
