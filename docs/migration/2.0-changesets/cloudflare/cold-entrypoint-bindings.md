---
'@velajs/cloudflare': patch
---

Initialize Cloudflare bindings and live invalidation before cold queue, scheduled, and email events, using the same initializer as HTTP requests. Failed initialization can be retried on a later event.
