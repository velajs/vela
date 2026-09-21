---
'@velajs/vela': patch
---

Capture the HTTP request context after body-limit normalization so middleware, guards, controllers, and adapters share the same readable Request and trusted identity. Keep request lifetimes active through oversized-body and body-read error reporting and cleanup.
