---
'@velajs/crud': minor
---

Generated CRUD routes answer and document their verbs' statuses under the core's success-status rule. The POST verbs that answer 200 (restore, upsert, import, batch restore and upsert, version rollback) declare it, so they keep answering 200 now that POST routes default to 201. An `@Override`'d verb answers and documents the status of the verb it takes over unless it declares its own `@HttpCode`.

**Behavior change:** an `@Override`'d `create`, `batchCreate` or `clone` handler without its own `@HttpCode` answers 201, the status of the verb it takes over, instead of 200. Add `@HttpCode(200)` to such a handler whose clients expect 200. OpenAPI documents 201 for the generated `batchCreate` and `clone`, which already answered it, instead of 200; regenerate clients built from the document.
