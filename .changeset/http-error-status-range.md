---
'@velajs/vela': minor
---

HTTP error edges answer only statuses from 400 to 599. As in Nest, `new HttpException(response, status)` still accepts any status and `getStatus()` returns it, but an exception constructed with another status, such as 200 or 302, is reported and renders as a redacted 500 (`{ error: { code: 'internal', message: 'Internal Server Error' } }`) instead of being sent with that status (with its object body, or an internal error body for a string response). `getErrorStatus()`, and so an exception filter's plain result, uses 500 for it too. Redirect with `@Redirect()` or by returning a `Response`.

A Hono `HTTPException` follows the same range. The raw Hono `onError` edge skips reporting only one with a 4xx status, a deliberate client response. In @velajs/vela 1.30.0 it skipped reporting every `HTTPException` below 500 and sent that exception's own response, so a raw middleware's `new HTTPException(302)` answered 302 with no report recorded.

**Behavior change:** `new HttpException(response, status)` with a status outside 400–599, such as `new HttpException('moved', 302)`, no longer answers with that status: it is reported and answers a redacted 500, and an exception filter's plain result for it is sent with 500. Redirect with `@Redirect()` or by returning a `Response` (for example `Response.redirect(url, 302)`) instead of throwing a 3xx `HttpException`.

**Behavior change:** a Hono `HTTPException` with a status outside 400–599 and no `res`, such as `new HTTPException(302)` thrown from raw Hono middleware, a raw Hono route or a Vela middleware, no longer answers with its own response: it is reported and answers a redacted 500. One built with its own `res`, such as `new HTTPException(302, { res: Response.redirect(url, 302) })`, still sends that response, but the raw Hono edge now reports it on every request. Redirect with `c.redirect()` or a returned `Response` instead of throwing a 3xx `HTTPException`.
