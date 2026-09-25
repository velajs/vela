---
'@velajs/vela': minor
'@velajs/studio-protocol': minor
'@velajs/studio': minor
'@velajs/studio-ui': minor
'@velajs/studio-host': minor
'@velajs/cli': minor
---

Module descriptions name their visibility flag `global`, as `ModuleMetadata` (`@Global()`) and `DynamicModule` do.

**Behavior change:** `ModuleDescription.isGlobal` (from `Container.getModuleDescriptions()`, `@velajs/vela/module-kit`) is removed; read `ModuleDescription.global`. The internal `ModuleScope.isGlobal` passed to `Container.registerScope()` (`@velajs/vela/internal`) is renamed `global` too. `vela module graph --json` and the `vela mcp serve` `module_graph`/`token_describe` results report `global` instead of `isGlobal`. The Studio wire protocol moves to version 4 (`STUDIO_PROTOCOL_VERSION`): `app.modules` rows carry `global` instead of `isGlobal` (`ModuleNode.global` in `@velajs/studio-protocol`), so upgrade `@velajs/studio`, `@velajs/studio-host` and `@velajs/studio-ui` together (a host or UI on protocol 3 refuses a protocol-4 application, and the reverse). Studio and CLI 1.31.0 read `isGlobal` and accept core 1.32.0 through their `^1.31.0` peer ranges without a warning: the CLI then reports no module as global, and Studio sends module rows without the `isGlobal` field its protocol-3 UI requires, so upgrade `@velajs/cli` and `@velajs/studio` to 1.32.0 with the core. The `isGlobal` registration extra of `forRoot()` options is unchanged.
