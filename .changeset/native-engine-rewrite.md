---
"@velajs/crud": minor
"@velajs/crud-memory": minor
"@velajs/crud-drizzle": minor
---

BREAKING — the engine is rewritten from scratch and the hono-crud dependency is
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
