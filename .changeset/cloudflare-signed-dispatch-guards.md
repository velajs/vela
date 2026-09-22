---
"@velajs/cloudflare": minor
---

**Behavior change:** the Cloudflare adapter rejects `ScheduleModule.forRoot({ dispatch: { kind: 'signed' } })` at bootstrap. Cron events call `@Cron` handlers directly, so the signed route and its global guards were silently skipped; call `InternalDispatcher.run()` from the handler to re-enter a signed route explicitly.

**Behavior change:** `cloudflareQueueDriver` only consumes through `QueueModule` when it has a `consumers` mapping. Signed `QueueModule` dispatch with a producer-only Cloudflare driver now fails at bootstrap instead of letting bridge deliveries skip the signed route. Signed dispatch with a consumer mapping keeps re-entering the signed route.
