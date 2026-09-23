---
"@velajs/cloudflare": minor
---

**Behavior change:** `cloudflareQueueDriver` only consumes through `QueueModule` when it has a `consumers` mapping. Signed `QueueModule` dispatch with a producer-only Cloudflare driver now fails at bootstrap instead of letting bridge deliveries skip the signed route. Signed dispatch with a consumer mapping keeps re-entering the signed route.
