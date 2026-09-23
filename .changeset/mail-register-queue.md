---
"@velajs/mail": minor
---

`MailModule` registers its own queue. With `queue` set, the mailer imports `QueueModule.registerQueue({ name, binding, consumer })` next to its `mail:send` consumer, so the application only imports `QueueModule.forRoot({ driver })`. The new `MailQueueOptions` accepts `binding`, the producer binding the driver sends through (a Wrangler `queues.producers[].binding` with `cloudflareQueues()`), and `consumer`, which pins the physical queue as in `registerQueue`. Native Cloudflare deliveries now reach the mail consumer through `cloudflareQueues()`.

**Behavior change:** `QueueModule.forRoot({ queues: ['mail'] })` no longer exists; replace it with `QueueModule.forRoot({ driver })` and let `MailModule.forRoot({ queue: { name: 'mail', binding: 'MAIL_QUEUE' } })` register the queue. A mailer configured with `queue` now fails bootstrap when the application does not import `QueueModule.forRoot()`, instead of failing with `queue_required` on the first `queue()` call.

The `queue_required` error of `MailService.queue()` now explains the fix: pass `queue: { name?, binding? }` to `MailModule.forRoot`, which registers the queue itself, and import `QueueModule.forRoot({ driver })` once in the root module.
