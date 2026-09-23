---
'@velajs/vela': patch
---

Resolve a handler's success status in one place for responses, OpenAPI documents and
`@CacheResponse`: an `@Endpoint` contract's status, then `@HttpCode`, otherwise 200 (204
for an empty result). OpenAPI documents that status as before, so a 2xx documented only
with `@ApiResponse` is listed beside the default 200 the handler still sends. Statuses are
unchanged.
