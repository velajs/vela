---
'@velajs/vela': patch
---

A module class that implements `NestModule` is now built, and its `configure(consumer)` called, once the whole module graph is registered, so `configure()` also sees providers from modules loaded after it, such as a global module imported later. The internal `bootstrap()` (`@velajs/vela/internal`) takes a `prepareGraph(container)` hook (`BootstrapInternals`) that changes the registered graph before any module class is built; `@velajs/testing` 1.32.0 applies its provider overrides and `useMocker` there.

`OpenApiModule` documents the controllers the application serves, in the order the root module declares them, instead of re-reading the root module's static metadata: after `overrideModule(Module).useModule(Replacement)`, the served document describes the replacement's routes instead of the replaced module's.
