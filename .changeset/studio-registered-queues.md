---
"@velajs/studio": minor
---

The queues panel lists every queue the application registers with `QueueModule.registerQueue()`, in union with the queues its `@Processor` providers handle, so a producer-only queue appears too. `queue.send` enqueues through the registered queue's client.

**Behavior change:** apps that mount `StudioQueueModule` configure queues with `QueueModule.forRoot()` plus `QueueModule.registerQueue({ name })` instead of `QueueModule.forRoot({ queues: [name] })`, which no longer exists. `queue.list` now includes registered queues without a processor.
