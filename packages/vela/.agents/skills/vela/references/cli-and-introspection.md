# CLI & Introspection (`@velajs/cli`)

`@velajs/cli` inspects a built Vela app — routes, module graph, entrypoints, OpenAPI, seeders — and serves the same surface to AI agents over MCP. Install as a dev dependency (`pnpm add -D @velajs/cli`); the binary is `vela` (space-separated commands). Subpaths include `.` (command runtime), `./config` and `./client`. Config and client helpers can be imported without Studio or MCP runtime loading.

## Config — `defineVelaConfig`

Add a `vela.config.{js,mjs,ts}` at the project root. The CLI tries those three names in that order in the current directory (override with `--config <path>`; no parent search). When the project installs Vite 8 (an optional peer of the CLI; `vela new` projects do), the CLI loads the config through Vite's `runnerImport` with Oxc legacy decorators + decorator metadata, so the config imports decorated `src/` files directly and no build runs first; packages still load from node_modules, and neither `vite.config.ts` nor tsconfig path aliases apply. Without Vite, Node imports the config: type stripping handles erasable `.ts` syntax but emits no decorators/DI metadata, so import compiled `.js` files with explicit extensions. Pin the CLI as a dev dependency and run it as `pnpm vela ...`.

```ts
// vela.config.ts
import { defineVelaConfig } from '@velajs/cli/config';
import { VelaFactory } from '@velajs/vela';
import { AppModule } from './src/app.module.js';

export default defineVelaConfig({
  createApp: () => VelaFactory.create(AppModule),
  rootModule: AppModule, // used by OpenAPI and client contract generation
});
```

`VelaConfig` requires `createApp` and accepts optional `rootModule`; `defineVelaConfig` preserves inferred app subtypes and custom properties. Supply local binding equivalents inside the factory if required. Config may be a default export or a named `config` export. Loading validates callable `createApp` and constructable `rootModule`. `resolveConfig` from `./config` resolves `{path, source, candidates}` without importing code. Commands that bootstrap an app dispose it after success/failure; cleanup warnings preserve the primary result.

## Commands

| Command | Flags | What it does |
|---|---|---|
| `vela doctor` | `--config`, `--app`, `--json` | Resolve config without import; opt-in `--app` bootstraps then snapshots app-local modules/routes/entrypoints without resolving lazy providers or emitting arbitrary metadata/values |
| `vela route list` | `--config`, `--json` | List HTTP routes (paths incl. prefix/version, named + contributed/CRUD routes, plus `(mounted)` sub-apps) |
| `vela module graph` | `--config`, `--json` | Print the module import graph with `global`/`lazy` flags, provider/export counts |
| `vela entrypoint list` | `--config`, `--json` | List declared entrypoint kinds (websocket, queue, cron, cf:*, …) and their entries |
| `vela openapi dump` | `--config`, `--out`, `--title`, `--api-version`, `--global-prefix` | Emit the OpenAPI document (needs `rootModule`); `--out` writes to a file, else stdout |
| `vela db seed` | `--config`, `--continue-on-error`, `--list`, `--json` | Run each seeder registration in order, or list names/orders/owners without executing seeders (`--json` requires `--list`) |
| `vela mcp serve` | `--config` | Start the MCP server over stdio (see below) |

`openapi dump` emits JSON directly. `doctor --app` and seeder inventory still run application startup/shutdown hooks; send application logs to stderr when consuming JSON.

```bash
vela route list
vela route list --json
vela module graph --json
vela openapi dump --out openapi.json --title "My API" --api-version 2.0.0
vela db seed --continue-on-error
```

## MCP server — `vela mcp serve`

`vela mcp serve` exposes app introspection to MCP clients over stdio (stdout is JSON-RPC only; logs go to stderr). Point a client at it with `{ "command": "vela", "args": ["mcp", "serve"] }`. It advertises `serverInfo.name` `@velajs/cli` and registers **five tools**:

| Tool | Input | Returns |
|---|---|---|
| `route_list` | — | all routes (same data as `vela route list`) |
| `module_graph` | `{ tree?: boolean }` | module descriptions; with `tree`, also a rendered tree |
| `entrypoint_list` | — | declared entrypoints |
| `openapi_dump` | `{ globalPrefix?, title?, apiVersion? }` | the OpenAPI document (errors if no `rootModule`) |
| `token_describe` | `{ token: string }` | `{ token, found, providedBy, module }` for a DI token |

When `rootModule` is set it also serves an MCP **resource** `vela://openapi` (`application/json`) — the full OpenAPI 3.1 document.

## The vela-side introspection seams

The CLI reads a built app through public `VelaApplication` seams (useful directly in scripts, too):

- `app.describeRoutes()` → `RouteDescription[]` (`{ method, path, controller, handler, version? }`).
- `app.getContainer().getModuleDescriptions()` → `ModuleDescription[]` (`{ moduleId, imports, isGlobal, lazy, providers, exports }`).
- `app.entrypoints.kinds()` / `app.entrypoints.ofKind(kind)` → declared non-HTTP entry surfaces.
- `app.getGlobalPrefix()` → the configured prefix.
- `describeToken(token)` (a `@velajs/vela` free function) → a human-readable token label.
- `createOpenApiDocument(rootModule, { globalPrefix?, info?, tags? })` → the OpenAPI document (see `references/openapi.md`).
- `runSeeders(app, { stopOnError })` (from `@velajs/vela/seeder`) backs `vela db seed` (see `references/seeders.md`).
