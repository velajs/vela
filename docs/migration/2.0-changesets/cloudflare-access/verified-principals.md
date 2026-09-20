---
'@velajs/cloudflare-access': major
---

Require finite JWT expiry, normalize it to `expiresAtMs`, emit stable issuer-scoped principals, prevent claim mappers from replacing verified authority fields, require explicit external-group to local-role mappings, and resolve permission policy only from the declaring route module while rejecting ambiguous providers.
