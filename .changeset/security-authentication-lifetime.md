---
'@velajs/vela': minor
'@velajs/better-auth': patch
'@velajs/cloudflare-access': patch
'@velajs/tenant': patch
'@velajs/authz': patch
---

Preserve authentication payload through verified tenant admission while retaining
invalidation on expiry, clear and reauthentication. Add explicit HTTP-backed
execution-context identity binding for custom dispatchers, and add a redacting
Secret value with runtime-private signing
credentials. Existing authentication and signing entrypoints remain compatible.
