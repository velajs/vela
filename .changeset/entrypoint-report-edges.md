---
'@velajs/vela': minor
---

`ErrorReportContext.edge` accepts `'durable-object'`, `'workflow'`, `'email'` and `'tail'`: the edges on which Cloudflare Durable Objects, Workflow runs, Email Workers messages and Tail Workers events report failures.

**Behavior change:** `ErrorReportContext.edge`, which an `ExceptionHandler`'s `report()` and `context()` receive, lists these four edges; a handler that switches exhaustively over `edge` must handle them.
