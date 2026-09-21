---
'@velajs/vela': patch
---

Keep request provider instances and synchronous cycle detection isolated by module registration,
including after provider replacement. Detect synchronous alias cycles without overflowing the stack.
Add optional exact-owner module IDs to provider scope, lazy-state and instance diagnostics while
preserving explicit request seeds and asynchronous construction deduplication.
