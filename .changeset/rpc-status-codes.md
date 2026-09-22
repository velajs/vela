---
'@velajs/rpc': patch
---

Derive RPC failure codes for `HttpException`s from the core catalog: 406, 408, 412 and 428
report `not_acceptable`, `request_timeout`, `precondition_failed` and
`precondition_required` instead of `bad_request`. 5xx messages remain redacted.
