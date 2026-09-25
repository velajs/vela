---
'@velajs/crud': minor
---

Generated CRUD routes answer and document their verbs' statuses under the core's success-status rule. The POST verbs that answer 200 (restore, import, batch restore and upsert, version rollback) declare it, so OpenAPI and `vela client generate` keep documenting 200 now that POST routes default to 201; the generated verbs send their own responses, so the statuses they answer do not change. The generated `upsert` declares 200 as well, but answers 201 when it creates the row and 200 when it updates one; OpenAPI documents only its 200. An `@Override`'d verb answers and documents the status of the verb it takes over unless it declares its own `@HttpCode`.

**Behavior change:** an `@Override`'d `create`, `batchCreate` or `clone` handler without its own `@HttpCode` answers 201, the status of the verb it takes over, instead of 200, unless it returns a ready `Response`, which keeps its own status. Add `@HttpCode(200)` to such a handler whose clients expect 200. OpenAPI documents 201 for the generated `batchCreate` and `clone`, which already answered it, instead of 200; regenerate clients built from the document.
