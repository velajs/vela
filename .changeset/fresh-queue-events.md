---
"@velajs/cloudflare": minor
---

Add the optional `@velajs/cloudflare/queue-events` subpath for Cloudflare platform event subscriptions inside existing `@QueueConsumer` handlers. Validate the documented versioned envelope, source/account/subscription expectations and Standard Schema payloads before awaiting explicit handlers. Acknowledge each success individually and request native retries for malformed, unmatched or failing messages while preserving partial-batch progress and DLQ behavior. Include a Worker build example, native delivery identity, idempotency and producer trust guidance, and workerd coverage separate from signed Vela job dispatch.
