---
'@velajs/cloudflare': minor
---

Build the R2 proxy `StorageModule` on `defineModule`, so it exposes `forRoot` and `forRootAsync` like every first-party module.

**Behavior change:** the R2 proxy `StorageModule` has one instance per application unless the caller passes `key`: a second configuration fails bootstrap instead of becoming another instance.
