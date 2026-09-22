---
'@velajs/vela': minor
---

Render a string `HttpException` identically from controller handlers, Vela middleware and
raw Hono middleware: `{ error: { code, message } }`, with the code taken from the status
(`not_acceptable` for 406, `bad_request` for an unmapped 4xx). Object responses still ship
verbatim from controller handlers and Vela middleware, and from raw Hono middleware below 500.

**Behavior change:** a 5xx string `HttpException` no longer sends its message to the client;
the body carries only the status title, such as
`{ error: { code: 'internal', message: 'Internal Server Error' } }`. Middleware exceptions
use the canonical body instead of `{ statusCode, message }`, and an `HttpException` thrown by
raw Hono middleware keeps its status instead of becoming a redacted 500. Its body is still
redacted to the status title at 5xx, including an object response, such as
`{ error: { code: 'service_unavailable', message: 'Service Unavailable' } }` for a 503.
