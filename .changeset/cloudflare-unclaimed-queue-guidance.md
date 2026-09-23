---
"@velajs/cloudflare": patch
---

A queue batch that no consumer claims now rejects with guidance: the error names the physical queue, points to `@QueueConsumer(name)` or `QueueModule.forRoot({ driver: cloudflareQueues() })` with a `QueueModule.registerQueue()` for each queue the batch carries, and states that the unacknowledged batch is retried and then dead-lettered by Cloudflare.
