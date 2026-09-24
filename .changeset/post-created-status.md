---
'@velajs/vela': minor
'@velajs/crud': patch
'@velajs/storage': patch
---

One rule decides every route's success status, shared by responses, OpenAPI and the response cache: `@HttpCode`, else the route's `status` option, else 204 for `response: null`, 201 for POST and 200 for every other method. Declaring both `@HttpCode` and `status` fails at startup. Generated CRUD POST verbs that answer 200 (restore, upsert, import, batch restore and upsert, version rollback) and the storage controller's POST routes declare that status, so their documents still match what they send. An `@Override`'d CRUD verb answers and documents the status of the verb it takes over unless it declares its own `@HttpCode`.

**Behavior change:** a POST route answers 201, as in Nest, instead of 200. Add `@HttpCode(200)` (or `status: 200`) to a POST route whose clients expect 200.

**Behavior change:** a handler returning `null` or `undefined` no longer answers 204; it answers the route's status with an empty body. Declare `response: null` or `@HttpCode(204)` where clients expect 204.
