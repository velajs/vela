---
'@velajs/vela': minor
---

One rule decides every route's success status, shared by responses, OpenAPI, generated clients and the response cache: `@HttpCode`, else the route's `status` option, else 204 for `response: null`, 201 for POST and 200 for every other method. Declaring both `@HttpCode` and `status` fails at startup. A handler that returns a ready `Response` (`c.json()`, `new Response()`) sends that Response's own status; OpenAPI and generated clients still document the rule's status.

**Behavior change:** a POST route answers 201, as in Nest, instead of 200, and OpenAPI and `vela client generate` document 201. Add `@HttpCode(200)` (or `status: 200`) to a POST route whose clients expect 200. A POST handler that returns a ready `Response` keeps answering its status (200 for `c.json(body)`), but is now documented as 201: declare `@HttpCode(200)` or `status: 200` on it too, so the document matches what it sends.

**Behavior change:** a handler returning `null` or `undefined` no longer answers 204; it answers the route's status with an empty body. Declare `response: null` or `@HttpCode(204)` where clients expect 204.
