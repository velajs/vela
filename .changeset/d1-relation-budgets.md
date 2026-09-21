---
"@velajs/crud-drizzle": patch
---

Budget D1 statement parameters before queries and writes, and chunk relation
includes while preserving tenant, authorization and soft-delete predicates.
Use bounded IN predicates to avoid large OR expression trees. Direct adapter
operations now enforce the active native-handle scope ownership contract.
