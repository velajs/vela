---
'@velajs/vela': minor
---

Add the two bootstrap seams `@velajs/testing` builds `overrideModule()` and `useMocker()` on. `bootstrap(rootModule, options, { moduleOverrides })` from `@velajs/vela/internal` loads each replacement wherever the graph imports the overridden module class or `DynamicModule` (the `ModuleLoader` takes the map as its third argument; `BootstrapInternals` and `ModuleOverrides` describe them), and `Container.supplyMissingDependencies(supply)` registers `supply(token)` in each module whose providers inject a token no visible provider satisfies, once per token.
