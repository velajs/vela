---
'@velajs/vela': minor
---

HTTP error edges answer only statuses from 400 to 599. As in Nest, `new HttpException(response, status)` still accepts any status and `getStatus()` returns it, but an exception constructed with another status, such as 200 or 302, is reported and renders as a redacted 500 (`{ error: { code: 'internal', message: 'Internal Server Error' } }`) instead of being sent with that status and an internal error body. `getErrorStatus()`, and so an exception filter's plain result, uses 500 for it too. Redirect with `@Redirect()` or by returning a `Response`.

The raw Hono `onError` edge reports such an error too: it skips reporting only a Hono `HTTPException` with a 4xx status, a deliberate client response, where it previously skipped every `HTTPException` below 500, so a raw middleware's `new HTTPException(302)` answered a 500 no report recorded.

**Behavior change:** `new HttpException(response, status)` with a status outside 400–599, such as `new HttpException('moved', 302)`, no longer answers with that status: it is reported and answers a redacted 500, and an exception filter's plain result for it is sent with 500. Redirect with `@Redirect()` or by returning a `Response` (for example `Response.redirect(url, 302)`) instead of throwing a 3xx `HttpException`.
