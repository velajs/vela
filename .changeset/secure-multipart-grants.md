---
'@velajs/storage': major
---

Secure browser-direct multipart uploads with actor-bound, key-bound, staging-key-bound, size-bound, part-count-bound, expiring HMAC grants. Multipart HTTP clients must now send the exact object size at creation and echo the returned grant on part signing, completion, and abort requests. Completion occurs under a reserved quarantine key and promotes the object only after validation. Storage dynamic-module identity now includes driver/factory, hooks, authorizer, and multipart-secret identity so distinct security configurations cannot collapse. HTTP routes are deny-only without an explicit authorizer; the insecure `defaultPolicy: 'allow'` compatibility path is removed. Proxy downloads now default to attachment, block HTML/SVG inline rendering, and emit `X-Content-Type-Options: nosniff`. Browser-facing `/sign-download` URLs now resolve object metadata and bind an attachment `Content-Disposition` into the provider signature.
