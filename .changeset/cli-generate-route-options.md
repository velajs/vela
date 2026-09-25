---
'@velajs/cli': patch
---

`vela generate resource` and the `api` template of `vela new` write decorator routes whose options declare their `response` schemas when the project uses zod, so each route shapes, documents and types its result. Generated POST routes answer 201, and DELETE routes answer 204 through `response: null` instead of `@HttpCode(204)`.
