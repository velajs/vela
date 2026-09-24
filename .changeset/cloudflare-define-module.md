---
'@velajs/cloudflare': minor
---

Build the R2 proxy `StorageModule` and `CloudflareWebSocketModule` on `defineModule`, so both expose `forRoot` and `forRootAsync` like every first-party module.

**Behavior change:** the R2 proxy `StorageModule` has one instance per application unless the caller passes `key`: a second configuration fails bootstrap instead of becoming another instance.
