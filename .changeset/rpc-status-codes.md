---
'@velajs/rpc': minor
---

Derive RPC failure codes for `HttpException`s from the core catalog. 5xx messages remain
redacted.

**Behavior change:** a 406, 408, 412 or 428 `HttpException` now fails with the code
`not_acceptable`, `request_timeout`, `precondition_failed` or `precondition_required` instead of
`bad_request`, and a 4xx failure carries the catalog's `hint` and `docsUrl` for its code when
the application catalog defines them. Clients that match on `error.code` must handle the new
codes.
