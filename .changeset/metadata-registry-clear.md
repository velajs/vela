---
"@velajs/vela": minor
---

**Behavior change:** `MetadataRegistry.clear()` is removed, with no alias. It had no effect: the registry holds decoration metadata only, and each application keeps its own state in its container. Delete the calls, typically `beforeEach(() => MetadataRegistry.clear())` in tests; no replacement is needed. Framework-internal suites that must wipe decoration metadata keep `MetadataRegistry.reset()`, available from `@velajs/vela/internal`.
