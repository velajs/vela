---
'@velajs/vela': minor
---

Add edge-safe, short-lived WebSocket socket tickets. Tickets use fixed-purpose HMAC claims bound to a gateway path, room, canonical principal, tenant, expiry, and generated nonce; strict verification atomically consumes the nonce through any structural `NonceStore` and fails closed for malformed, tampered, mismatched, expired, or replayed credentials.
