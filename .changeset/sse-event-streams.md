---
'@velajs/vela': minor
---

`@Sse()` streams Server-Sent Events, as in Nest: its handler returns an async iterable (such as an `async *` generator) or an iterable of `MessageEvent` (`{ data, id?, type?, retry? }`). Each event is streamed with Hono's `streamSSE` as it is produced, the iterable is closed when the client disconnects, and a failure mid-stream is reported without sending its message. A returned `Response` is still sent as is. `@Sse` no longer loads in a Worker that does not use it.

**Behavior change:** `@Sse()` is no longer a plain GET route that sends its handler's result like any other route: the handler must return an iterable or async iterable of `MessageEvent`, or a `Response` (`SseResult`). Another return type no longer compiles, and a handler that returns anything else, such as a JSON object, fails the request with a reported, redacted 500. Yield `MessageEvent`s, or keep returning the `Response` of Hono's `streamSSE(c, ...)`.
