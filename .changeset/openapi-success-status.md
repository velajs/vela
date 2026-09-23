---
'@velajs/vela': minor
---

Resolve a handler's success status in one place for responses, OpenAPI documents and
`@CacheResponse`: an `@Endpoint` contract's status, then `@HttpCode`, otherwise 200 (204
for an empty result). Default statuses are unchanged.

**Behavior change:** `createOpenApiDocument()` no longer adds a default `200 OK` response
to an operation that declares no status but documents a 2xx response with `@ApiResponse`,
such as `@ApiResponse(201, ...)`. Such operations previously listed both 200 and the
documented status, and generated clients typed the phantom 200 as a possible result.
Operations with only error responses documented still receive the default 200.
