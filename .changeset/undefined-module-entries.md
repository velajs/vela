---
"@velajs/vela": minor
---

**Behavior change:** an `undefined` or `null` entry in a module's `imports`, `providers`, `controllers` or `exports` now fails the load with the new `UndefinedModuleError`, for example `AppModule.imports[2] is undefined — usually a circular file import; use forwardRef(() => X)`. The error exposes `moduleName`, `property` and `index`. Previously the loader failed with an unrelated `TypeError`, and `createOpenApiDocument` silently skipped the entry.
