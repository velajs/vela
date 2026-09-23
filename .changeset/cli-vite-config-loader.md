---
'@velajs/cli': minor
---

**Behavior change:** when the project installs Vite 8, `loadConfig()` and every command that reads `vela.config.{js,mjs,ts}` load the config, and the relative files it imports, through a Vite module runner with Oxc legacy decorators and decorator metadata; packages still load from `node_modules`, and neither the project's Vite config nor tsconfig path aliases apply. A config can therefore import decorated TypeScript source directly, at the top level or lazily from `createApp()` (`await import('./src/app.module.js')`): the runner stays open for the whole command and closes after the app is disposed. `vite` is a new optional peer dependency. Without it, Node imports the config as before, and the load error now explains how to install Vite or import compiled `.js` files.

**Behavior change:** `loadConfig()` now resolves to `{ config, path, dispose }` (the new `LoadedVelaConfig` type) instead of the config itself. Call `config.createApp()` as before, then `await dispose()` once the app is disposed to close the module runner that loaded the config.
