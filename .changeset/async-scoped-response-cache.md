---
'@velajs/vela': minor
'@velajs/cloudflare': minor
---

Add opt-in asynchronous response caching with explicit trusted partitions, bounded JSON replay, and generic scoped generation-based invalidation. Preserve the synchronous CacheService API and provide an independent optional KV invalidation adapter with documented eventual-consistency limits. Preserve absolute expiry during tier backfill and KV physical retention, and fence fills that race with visible invalidation.
