---
"@velajs/vela": patch
"@velajs/testing": minor
---

Use shared application finalization in testing, recalculate request scope after
provider overrides, and dispose resources on failed startup and shutdown. Await
concurrent disposal and managed test scopes. Add onClose fixture cleanup and close
Node WebSocket test servers with their owning testing module.

