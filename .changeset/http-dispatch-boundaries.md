---
"@velajs/vela": patch
---

Scope controller and handler middleware to its HTTP method and route, preserving Hono onion and HEAD behavior. Defer request-scoped controller construction until handler invocation and route pipeline component construction errors through the HTTP reporting/filter boundary.

Resolve asynchronous controller and scoped pipeline dependencies in their declaring module, including parameter pipes, without selecting another module's registration of the same class.

Give every HTTP request and adapter route a managed invocation lifetime. Start deferred work after dispatch and wait for work plus response completion before disposing resources; retain async cleanup with native waitUntil and correctly finish HEAD/cancelled streams.
