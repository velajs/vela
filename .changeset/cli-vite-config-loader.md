---
'@velajs/cli': minor
---

**Behavior change:** when the project installs Vite 8, `loadConfig()` and every command that reads `vela.config.{js,mjs,ts}` load the config, and the relative files it imports, through Vite's module runner (`runnerImport`) with Oxc legacy decorators and decorator metadata; packages still load from `node_modules`, and neither the project's Vite config nor tsconfig path aliases apply. A config can therefore import decorated TypeScript source directly. `vite` is a new optional peer dependency. Without it, Node imports the config as before, and the load error now explains how to install Vite or import compiled `.js` files.
