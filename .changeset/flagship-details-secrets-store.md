---
'@velajs/feature-flags': minor
'@velajs/cloudflare': minor
'@velajs/crypto': minor
'@velajs/studio-protocol': minor
'@velajs/studio': patch
---

Preserve native Flagship evaluation reasons, variants and error codes through optional driver detail methods and Studio responses. Value-only providers now report UNKNOWN instead of STATIC; native context accepts only scalar attributes, and route guards deny all evaluation errors. Existing object-validation callback signatures are unchanged.

Add the optional crypto/cloudflare SecretsStoreKeyProvider for immutable, versioned AES-KW key material, with explicit per-instance caching, refresh, retry and rotation using retained decryption keys. Secrets Store supplies material for local Web Crypto; it is not a remote KMS.
