---
'@velajs/vela': minor
---

`TRUSTED_REQUEST_IDENTITY` from `@velajs/vela/module-kit` reads the request's trusted identity through `REQUEST_CONTEXT`: `requestContext.get(TRUSTED_REQUEST_IDENTITY)`. It is a read-only view of `getTrustedRequestIdentity(request)`, and `set()` throws, so `setTrustedRequestIdentity` stays the single identity model. `new RequestContextKey(description, { derive })` creates such derived, read-only keys.

**Behavior change:** `ThrottlerGuard` publishes its decisions (one `{ limit, remaining?, reset }` per named throttler) under the `RATE_LIMIT` request-context key from `@velajs/vela/throttler` instead of the untyped `rateLimit` Hono variable. Replace `c.get('rateLimit')` with `requestContext.get(RATE_LIMIT)?.default`.
