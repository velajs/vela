# Roadmap (post-1.18.1)

`packages/core/PARITY.md` is the authoritative deviation/gap ledger — this file
is the triaged build order on top of it. The erpos migration
(erpos-ai/erpos-internal#315, merged) is the consumer proof-ground: items it
hit directly come first.

## 1.19 — consumer-driven engine gaps (small, high value)

1. **Per-endpoint guard seam** — DONE (1.19): `guards?:
   Partial<Record<CrudEndpointName, GuardType[]>>` on `CrudConfig`, stamped
   per synthesized handler via vela's public `UseGuards` (PARITY.md carries
   the closed entry + proving tests).
2. **Tenant in the transaction seam** — DONE (1.19):
   `transaction(fn, ctx?: TransactionContext)` overload, threaded at every
   kernel tx-open site, plus the drizzle `onOpenTransaction(tx, ctx)` config
   seam for RLS GUCs (PARITY.md carries the closed entry).
3. **`id: 'client'` PK strategy** — DONE (1.19): `'client'` on `IdStrategy`
   keeps the caller-supplied PK required in the create body (static +
   resolveSchema derivation + OpenAPI DTO) and skips engine generation;
   retires erpos's `ClientPkCaptureGuard` (PARITY.md carries the closed
   entry).
4. **Cleanup** — DONE (1.19): the vestigial `IMPLEMENTED_ENDPOINTS` export is
   removed from `verb-table.ts` and the barrel; the live source of implemented
   verbs is `kernel/extended/registry.ts` `implementedEndpoints()`.

## Engine features with hono-crud reference cells (proofs ready to port)

5. Serialization profiles — DONE (1.19): model-level `serializationProfile`
   (`{ exclude }`) wired through the shared shaping tails; finalize-pipeline
   cell (cell 12) runs over both adapters. `include`/`alwaysInclude`/
   `transform` remain unported.
6. Nested-write schema merging — DONE (1.19): `nestedWrites` on
   `RelationConfig`, schema merge in both derivations, create/update dispatch
   to the `NestedWriteDriver` in-transaction; extended verbs reject nested
   payloads (400). belongsTo nesting + create-via-set deliberately unported
   (PARITY.md carries the shipped entry).
7. ETag/If-Match concurrency + unique-constraint surface — unblocks the
   etag-concurrency and unique-conflict cells.
8. Events family; field-level encryption (erpos uses its own encryption hooks,
   so demand is unproven — verify before building).

## Triage-first (crud-core vs sibling package vs vela-core vs won't-do)

9. cache, rate-limit, idempotency, api-version, health, logging middleware,
   swagger/scalar UIs, prisma adapter. MCP is likely covered by
   `@velajs/cli mcp serve` — confirm, then won't-do here.

## Adapter residuals

10. Drizzle pg/mysql branches are written per hono-crud but UNTESTED (sqlite/
    libsql only); add legs when a consumer needs them.
11. Workers-pool conformance leg — deferred with rationale in PARITY.md.

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
