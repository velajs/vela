---
'@velajs/vela': patch
---

Dispose transient providers with their retaining request or singleton graph, preserving caller-owned
values and seeds. Wait for owned asynchronous construction before disposal, coalesce concurrent
teardowns and prevent new resolution during teardown while retaining container reuse after disposal.
Keep factory-returned existing resources with their original owner and dispose each only once.
Protect mutable container state with JavaScript private fields.
