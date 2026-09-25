---
'@velajs/vela': minor
'@velajs/crud': minor
'@velajs/rpc': minor
'@velajs/graphql': minor
---

Every HTTP failure renders through one function, `renderHttpError(error, { catalog?, redactServerBodies? })`, exported from `@velajs/vela` with `getErrorStatus(error)`. Controller handlers, Vela middleware, the last-resort Hono `onError`, unmatched routes, request limits, RPC and GraphQL all derive their status and body there, after exception filters and the application's `ExceptionHandler.render` hook. It returns `{ status, body, redacted }`.

- An exception owns its wire shape through `toResponse()`, which returns `{ status, body }` (`HttpErrorResponse`). `HttpException` returns an object response verbatim, as before, so a health check's 503 still ships as written; a string response takes the canonical `{ error: { code, message, details? } }` body. Only exceptions the `HttpException` constructor built, including subclasses such as `CrudException`, own a response: the constructor brands them. Any other thrown object with a `toResponse()` is an unknown error, reported and answered with a redacted 500, so a third-party error cannot choose its own status or body. `CrudException` renders its `{ success: false, error }` envelope through `toResponse()` and keeps its human-readable `message`. Errors thrown by raw Hono middleware reach only `onError`, which redacts an owned 5xx body to its status title, as RPC frames do.
- `HttpException` and each subclass accept `options` (`{ details, cause }`). A 4xx sends `details` as `error.details`; a 5xx sends neither its text nor its details. `getDetails()` reads them.
- Unmatched routes answer a JSON 404 (`{ error: { code: 'not_found', message: 'Not Found' } }`), including Workers built with `createCloudflareWorker`, and oversized bodies a JSON 413 (`payload_too_large`). These and the query-limit 400s are not reported. As in Nest, global exception filters receive them (`NotFoundException`, `PayloadTooLargeException`, `BadRequestException`), and a filter's plain result keeps their status.
- A Hono `HTTPException` below 500 renders its message in the canonical body on every edge; one built with its own `res`, such as an auth challenge, keeps that response and its headers.
- GraphQL maps a field error's status from the shared renderer, so branded `VelaError`s and exception-owned responses reach the same public codes (`FORBIDDEN`, `NOT_FOUND`, …) as `HttpException`s. An RPC failure frame carries only `{ code, message, status }`. When the rendered body has `error.code` and `error.message` (the canonical body, or an exception-owned 4xx body with that member, such as the CRUD envelope), the frame keeps the message and the code, or the status's code when that code is malformed; otherwise it sends the status's code and a generic message. A frame coded `internal` always carries the generic message, and a 5xx owned body is redacted first.

**Behavior change:** validation failures from `ValidationPipe`, `@Body(schema)` and route contracts answer `{ error: { code: 'bad_request', message: 'Validation failed', details: { issues } } }` instead of `{ statusCode, message, errors }`. The thrown `BadRequestException` carries the issues in `getDetails()`.

**Behavior change:** an exception filter's result is sent with the exception's status (`HttpException.getStatus()`, `VelaError.status`, else 500) instead of 200. Return `{ status, body }` (exactly those keys) to set the status explicitly, or a `Response`. A filter that returns `undefined` no longer sends an empty 204: the error falls through to the default renderer. RPC applies the same rules to the status it keeps.

**Behavior change:** `HttpException.getRawResponse()` is removed. Override `toResponse()` to own an exception's response, and call `renderHttpError(error)` to map an error to another transport.
