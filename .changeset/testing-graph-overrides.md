---
'@velajs/testing': minor
---

Provider overrides and `useMocker` apply to the registered module graph before any module class is built. `useMocker` therefore supplies the constructor dependencies of a module class that implements `NestModule`, and `overrideProvider()` replaces them, where compiling used to fail with `UnresolvedDependencyError` or build the module with the original provider; its `configure(consumer)` sees the replacements too.

**Behavior change:** this release requires `@velajs/vela` 1.32.0, and its peer range becomes `^1.32.0`. It applies overrides through a bootstrap step an earlier core does not run, so on core 1.31 `overrideProvider()` and `useMocker` would silently not apply. Upgrade the core and `@velajs/testing` together.
