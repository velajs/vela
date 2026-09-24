---
'@velajs/vela': patch
---

HTTP error edges answer only statuses from 400 to 599. As in Nest, `new HttpException(response, status)` still accepts any status and `getStatus()` returns it, but an exception constructed with another status, such as 200 or 302, is reported and renders as a redacted 500 (`{ error: { code: 'internal', message: 'Internal Server Error' } }`) instead of being sent with that status and an internal error body. `getErrorStatus()`, and so an exception filter's plain result, uses 500 for it too. Redirect with `@Redirect()` or by returning a `Response`.
