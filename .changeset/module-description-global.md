---
'@velajs/vela': minor
'@velajs/studio-protocol': minor
'@velajs/studio': minor
'@velajs/studio-ui': minor
'@velajs/studio-host': minor
'@velajs/cli': minor
---

Module descriptions name their visibility flag `global`, as `ModuleMetadata` (`@Global()`) and `DynamicModule` do.

**Behavior change:** `ModuleDescription.isGlobal` (from `Container.getModuleDescriptions()`, `@velajs/vela/module-kit`) is removed; read `ModuleDescription.global`. The internal `ModuleScope.isGlobal` passed to `Container.registerScope()` (`@velajs/vela/internal`) is renamed `global` too. `vela module graph --json` and the `vela mcp serve` `module_graph`/`token_describe` results report `global` instead of `isGlobal`. The Studio wire protocol moves to version 4: `app.modules` rows carry `global` instead of `isGlobal`, so upgrade `@velajs/studio`, `@velajs/studio-host` and `@velajs/studio-ui` together (a host or UI on protocol 3 refuses a protocol-4 application, and the reverse). The `isGlobal` registration extra of `forRoot()` options is unchanged.
