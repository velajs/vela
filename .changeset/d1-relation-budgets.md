---
"@velajs/crud-drizzle": patch
---

Budget D1 statement parameters before queries and writes, and chunk relation
includes while preserving tenant, authorization and soft-delete predicates.
Use bounded IN predicates to avoid large OR expression trees. Direct adapter
operations now enforce the active native-handle scope ownership contract.
Prepare statements once to preserve generated defaults through inspection and
execution, including atomic batches, and accept schema-aware D1 handles.
