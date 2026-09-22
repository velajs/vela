---
'@velajs/vela': patch
---

`Reflector.createDecorator()` no longer generates random values when no `key` is given, so a Worker that declares typed decorators at module scope starts instead of failing with workerd's "Disallowed operation called within global scope" error. Default keys stay unique within the process, including across duplicated package copies and hot-reloaded modules.
