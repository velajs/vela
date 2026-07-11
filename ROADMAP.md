# Roadmap (post-1.19.0)

`packages/core/PARITY.md` is the authoritative deviation/gap ledger — this file
is the triaged build order on top of it.

## Shipped in 1.19.0 (2026-07-11)

The consumer-driven engine gaps (erpos-ai/erpos-internal#315 proof-ground) and
every hono-crud-referenced conformance cell are CLOSED: per-endpoint `guards`
on `CrudConfig`; `TransactionContext` through `adapter.transaction()` + the
drizzle `onOpenTransaction` RLS seam; the `id: 'client'` PK strategy (retires
erpos's `ClientPkCaptureGuard`); model-level `serializationProfile` (cell 12);
nested writes end to end (`nestedWrites` on `RelationConfig` — the driver was
dead code before); ETag/If-Match (409 per hono-crud) + `unique` tuples with
the `uniqueConstraints` capability (cells 13/14); the drizzle pg leg (PGlite);
and the `IMPLEMENTED_ENDPOINTS` cleanup. Details live in each package's
CHANGELOG and the closed PARITY.md entries. Conformance: 14 cells / 92 tests
over both adapters.

erpos follow-ups unlocked by 1.19.0 (erpos-side work): delete
`ClientPkCaptureGuard`, replace `@RequireFeature` post-stamping with
`config.guards`, wire `onOpenTransaction` for the RLS-GUC delta.

## Open — all gated; none is plain build-next work

1. **Events family; field-level encryption** — demand UNPROVEN (erpos uses
   its own encryption hooks); confirm a consumer wants it before building.
2. **Cross-cutting middleware triage** — cache, rate-limit, idempotency,
   api-version, health, logging middleware, swagger/scalar UIs, prisma
   adapter: decide crud-core vs sibling package vs vela-core per family.
   MCP is likely covered by `@velajs/cli mcp serve` — confirm, then won't-do
   here.
3. **Workers-pool conformance leg** — deferred: the drizzle leg cannot run in
   workerd (libsql client) and the edge guarantee is machine-verified by the
   openness/edge import audits; revisit if a D1-flavored adapter lands.
4. **mysql dialect leg** — written per hono-crud but UNTESTED (no embeddable
   server); add when a consumer needs the dialect.
5. **Serialization-profile extensions** — hono-crud's `include`/
   `alwaysInclude`/`transform` profile options remain unported (`exclude` is
   the proven need); port on demand.

## Vela-side (owning repo: ../vela)

- Sub-app `onError`: since the 1.11 pipeline, a parent app's `onError` doesn't
  cover hono `.route()` sub-apps (they render locally when they have any error
  handler). Docs note or opt-in fall-through; erpos intercepts `route()` in its
  bootstrap meanwhile.

## Conventions (unchanged)

Worktrees + CLAIMED markers for concurrent sessions; push `HEAD:main`; break
freely on 1.x with lockstep consumer migration (examples + erpos kernel);
changesets with the core/memory/drizzle fixed group; every closed gap flips its
PARITY.md entry and lands its conformance cell.
