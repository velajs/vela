---
"@velajs/vela": minor
---

Add the internal-dispatch seam: `InternalDispatcher.run()` re-enters the app through named routes using per-invocation HMAC-signed claims (audience-tagged, method/path/body-hash-bound, short-TTL, nonce single-use via a pluggable `NonceStore`), verified fail-closed by the new `@SignedInvocation()` guard. Shared HMAC/base64url plumbing is extracted to `crypto/hmac.ts` and reused by the existing signed-URL feature unchanged.
