---
'@velajs/vela': minor
---

Preserve module constructor/key identity in dependency cycles and OpenAPI traversal,
initialize each owned provider registration, and carry module ownership through
additive metadata-only discovery APIs and entrypoint records. Existing token-level
discovery remains supported.

Preserve the declaring module for configured middleware and controller mounts.
Ambiguous mounts of the same controller class in different module instances now
fail explicitly instead of selecting the first owner.
