---
"@velajs/crud": patch
"@velajs/storage": patch
---

Normalize generated CRUD names and storage prefixes in linear passes so long
separator runs cannot cause regular-expression backtracking. Preserve existing
operation IDs, controller/DTO names, and prefix scoping behavior.
