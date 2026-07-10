# Roadmap (post-1.18.1)

`packages/core/PARITY.md` is the authoritative deviation/gap ledger — this file
is the triaged build order on top of it. The erpos migration
(erpos-ai/erpos-internal#315, merged) is the consumer proof-ground: items it
hit directly come first.

## 1.19 — consumer-driven engine gaps (small, high value)

1. **Per-endpoint guard seam** — `guards?: Partial<Record<CrudEndpointName,
   GuardType[]>>` on `CrudConfig`, stamped per handler (headless `forFeature`
   resources currently can't wire per-verb ACL; erpos works around it by
   post-stamping `@RequireFeature`).
2. **Tenant in the transaction seam** — optional
   `transaction(fn, ctx?: { tenantId? })` overload so RLS-GUC setups
   (`SET LOCAL app.tenant_id`) see the request tenant at tx-open (erpos
   TODO in its coworker adapter).
3. **`id: 'client'` PK strategy** — keep the client-supplied PK in the create
   body schema and skip generation (erpos ships a `ClientPkCaptureGuard`
   workaround today).
4. **Cleanup**: `verb-table.ts` still exports the vestigial static
   `IMPLEMENTED_ENDPOINTS` (5 verbs); the live source is
   `kernel/extended/registry.ts` `implementedEndpoints()`. Remove or re-point
   the export.

## Engine features with hono-crud reference cells (proofs ready to port)

5. Serialization profiles (`serializationProfile`) — unblocks the
   finalize-pipeline conformance cell.
6. Nested-write schema merging (`nestedWrites` on `RelationConfig`) —
   `deriveCreateSchema` doesn't merge relation write shapes.
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
