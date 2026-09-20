# CLI & Introspection (`@velajs/cli`)

`@velajs/cli` inspects a built Vela app — routes, module graph, entrypoints, OpenAPI, seeders — and serves the same surface to AI agents over MCP. Install as a dev dependency (`pnpm add -D @velajs/cli`); the binary is `vela` (space-separated commands). Peer: `@velajs/vela >=1.15.0`. Subpaths: `.` and `./config`.

## Config — `defineVelaConfig`

Add a `vela.config.{js,mjs,ts}` at the project root. The CLI tries those three names in that order (override with `--config <path>`); a `.ts` config needs a type-stripping runtime (Node 22+ `--experimental-strip-types`, tsx, or ts-node).

```ts
// vela.config.ts
import { defineVelaConfig } from '@velajs/cli/config';
import { AppModule } from './src/app.module';
import { createApp } from './src/main';

export default defineVelaConfig({
  createApp,           // () => Promise<VelaApplication> | VelaApplication  (required)
  rootModule: AppModule, // only needed by `openapi dump` and the MCP OpenAPI surfaces
});
```

`VelaConfig` has exactly two fields: `createApp` (required) and `rootModule` (optional). Every command builds the app through `createApp()`; `rootModule` is used solely for OpenAPI generation. Config may be a default export or a named `config` export.

## Commands

| Command | Flags | What it does |
|---|---|---|
| `vela route list` | `--config`, `--json` | List HTTP routes (paths incl. prefix/version, named + contributed/CRUD routes, plus `(mounted)` sub-apps) |
| `vela module graph` | `--config`, `--json` | Print the module import graph with `global`/`lazy` flags, provider/export counts |
| `vela entrypoint list` | `--config`, `--json` | List declared entrypoint kinds (websocket, queue, cron, cf:*, …) and their entries |
| `vela openapi dump` | `--config`, `--out`, `--title`, `--api-version`, `--global-prefix` | Emit the OpenAPI document (needs `rootModule`); `--out` writes to a file, else stdout |
| `vela db seed` | `--config`, `--continue-on-error` | Build the app and run all `@Seeder()` classes in order (exit 1 if any fail) |
| `vela mcp serve` | `--config` | Start the MCP server over stdio (see below) |

Only the three `list`/`graph` commands take `--json`; `openapi dump`, `db seed`, and `mcp serve` do not.

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
