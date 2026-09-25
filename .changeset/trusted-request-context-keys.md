---
'@velajs/vela': minor
---

`TRUSTED_REQUEST_IDENTITY` from `@velajs/vela/module-kit` reads the request's trusted identity through `REQUEST_CONTEXT`: `requestContext.get(TRUSTED_REQUEST_IDENTITY)`. It is a read-only view of `getTrustedRequestIdentity(request)`, and `set()` throws, so `setTrustedRequestIdentity` stays the single identity model. `new RequestContextKey(description, { derive })` creates such derived, read-only keys.
