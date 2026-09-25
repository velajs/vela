---
'@velajs/vela': patch
'@velajs/testing': patch
---

A module class that implements `NestModule` is now built, and its `configure(consumer)` called, once the whole module graph is registered, and in `@velajs/testing` after the testing module's provider overrides and `useMocker` apply. `useMocker` therefore supplies such a module's constructor dependencies, and `overrideProvider()` replaces them, where compiling used to fail with `UnresolvedDependencyError` or build the module with the original provider. `configure()` also sees providers from modules loaded after it, such as a global module imported later. `@velajs/testing` 1.31.1 requires `@velajs/vela` 1.32.0 (its peer range becomes `^1.32.0`): on an earlier core, `overrideProvider()` and `useMocker` would not apply.

`OpenApiModule` documents the controllers the application serves, in the order the root module declares them, instead of re-reading the root module's static metadata: after `overrideModule(Module).useModule(Replacement)`, the served document describes the replacement's routes instead of the replaced module's.
