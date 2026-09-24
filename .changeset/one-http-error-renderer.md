---
'@velajs/vela': minor
'@velajs/crud': minor
'@velajs/rpc': minor
'@velajs/graphql': minor
---

Every HTTP failure renders through one function, `renderHttpError(error, { catalog?, redactServerBodies? })`, exported from `@velajs/vela` with `getErrorStatus(error)`. Controller handlers, Vela middleware, the last-resort Hono `onError`, unmatched routes, request limits, RPC and GraphQL all derive their status and body there, after the application's `ExceptionHandler.render` hook. It returns `{ status, body, redacted }`.

- An exception owns its wire shape through `toResponse()`, which returns `{ status, body }` (`HttpErrorResponse`). `HttpException` returns an object response verbatim, as before, so a health check's 503 still ships as written; a string response takes the canonical `{ error: { code, message, details? } }` body. `CrudException` renders its `{ success: false, error }` envelope through `toResponse()` and keeps its human-readable `message`. Errors thrown by raw Hono middleware reach only `onError`, which redacts an owned 5xx body to its status title, as RPC frames do.
- `HttpException` and each subclass accept `options` (`{ details, cause }`). A 4xx sends `details` as `error.details`; a 5xx sends neither its text nor its details. `getDetails()` reads them.
- Unmatched routes answer a JSON 404 (`{ error: { code: 'not_found', message: 'Not Found' } }`), including Workers built with `createCloudflareWorker`, and oversized bodies a JSON 413 (`payload_too_large`). These and the query-limit 400s render through the application's render hook but are not reported and skip exception filters.
- GraphQL maps a field error's status from the shared renderer, so branded `VelaError`s and exception-owned responses reach the same public codes (`FORBIDDEN`, `NOT_FOUND`, …) as `HttpException`s. RPC failures keep only the canonical code and message, and use an owned body's status alone.

**Behavior change:** validation failures from `ValidationPipe`, `@Body(schema)` and `@Endpoint` input answer `{ error: { code: 'bad_request', message: 'Validation failed', details: { issues } } }` instead of `{ statusCode, message, errors }`. The thrown `BadRequestException` carries the issues in `getDetails()`.

**Behavior change:** an exception filter's result is sent with the exception's status (`HttpException.getStatus()`, `VelaError.status`, else 500) instead of 200. Return `{ status, body }` (exactly those keys) to set the status explicitly, or a `Response`. A filter that returns `undefined` no longer sends an empty 204: the error falls through to the default renderer. RPC applies the same rules to the status it keeps.

**Behavior change:** `HttpException.getRawResponse()` is removed. Override `toResponse()` to own an exception's response, and call `renderHttpError(error)` to map an error to another transport.
