---
'@velajs/mail': patch
---

Dispatch each owner-bearing inbound email entrypoint once. Preserve module
expansion for legacy ownerless entries and reject owners outside the application.
