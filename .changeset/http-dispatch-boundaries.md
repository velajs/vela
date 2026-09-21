---
"@velajs/vela": patch
---

Scope controller and handler middleware to its HTTP method and route, preserving Hono onion and HEAD behavior. Defer request-scoped controller construction until handler invocation and route pipeline component construction errors through the HTTP reporting/filter boundary.
