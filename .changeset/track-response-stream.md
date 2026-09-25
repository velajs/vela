---
'@velajs/vela': minor
---

`trackResponseStream(body, onFinish?)` from `@velajs/vela/module-kit` tracks the transmission of a response body, as the HTTP edge does: send the returned `body` in place of the original, and `done` resolves once it was read to the end, failed or was cancelled (after the producer's cancellation settles), with the outcome passed to `onFinish`. Runtime adapters pass `done` to `ExecutionScope.finish()` to keep an invocation's request-scoped providers and managed work alive while a streamed response is sent; Cloudflare Durable Object hosts use it for `fetch()`.
