---
'@velajs/vela': minor
'@velajs/crud': minor
'@velajs/crud-memory': minor
'@velajs/crud-drizzle': minor
'@velajs/crud-durable-objects': minor
'@velajs/studio': minor
---

Enforce include allowlists and strict bulk mutation filters, run point-read hooks inside the read scope, and reject D1 mutations whose read policies require interactive transactions. Require transactional row locking for ETag resources and lock before validating If-Match to prevent concurrent lost updates.

Remove nonfunctional relation cascade configuration and the CRUD cascade driver. Use database foreign keys for hard-delete actions or explicit transactional hooks for soft-delete propagation. Studio's CRUD source no longer advertises a cascade preview without database constraint metadata.

Remove implicit Hono context arguments, process-global Logger configuration, and the ComponentManager interceptor alias. Use explicit @Ctx(), instance-owned logging or LoggingModule, and PipelineRunner.chainInterceptors.
