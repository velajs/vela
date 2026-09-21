---
'@velajs/vela': minor
---

Correct queue disposition observation to retain the first successful ack/retry, count the initial delivery separately from retries, and distinguish unknown DLQ configuration. Add per-application queue driver factories, reject unsafe rebinding, and dispose inline bindings without retaining pending jobs.
