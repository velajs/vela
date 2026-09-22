---
"@velajs/vela": minor
---

**Behavior change:** `QueueModule.forRoot({ dispatch: { kind: 'signed' } })` now fails at bootstrap when its driver implements neither `bind()` nor `consume()`. Such drivers deliver jobs outside the module, so the signed route and its global guards were silently skipped. Use a driver that consumes through the module, or remove signed dispatch from producer-only modules.
