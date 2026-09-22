---
"@velajs/cloudflare": patch
---

A queue batch that no consumer claims now rejects with guidance: the error names the physical queue, points to `@QueueConsumer(name)` or a `cloudflareQueueDriver({ consumers })` mapping, and states that the unacknowledged batch is retried and then dead-lettered by Cloudflare.
