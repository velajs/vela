# CLI & Introspection (`@velajs/cli`)

`@velajs/cli` inspects a built Vela app — routes, module graph, entrypoints, OpenAPI, seeders — and serves the same surface to AI agents over MCP. Install as a dev dependency (`pnpm add -D @velajs/cli`); the binary is `vela` (space-separated commands). Subpaths include `.` (command runtime), `./config` and `./client`. Config and client helpers can be imported without Studio or MCP runtime loading.

## Loading the application

In a Workers project no configuration is needed. Without a `vela.config`, the CLI reads `main` from `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` in the current directory (`--env <name>` selects a named environment's `main` and `vars`), loads that entry through a Vite module runner with Oxc legacy decorators and metadata, and reads the descriptor the Worker of `defineCloudflareApp(AppModule, options)` (or `createCloudflareWorker(AppModule, options)`) attaches under `Symbol.for('vela.cloudflare.worker')` (`CLOUDFLARE_WORKER` from `@velajs/cloudflare`: `{ rootModule, options, durableObjects, createOptions(env), createApplication(env) }`); each class `VelaDurableObject()`/`VelaWebSocketDurableObject()` builds carries its own descriptor under `Symbol.for('vela.cloudflare.durableObject')` (`kind: 'host' | 'websocket'`, host, RPC methods). `cloudflare:*` imports resolve to inert Node stand-ins (a `DurableObject` or `WorkflowEntrypoint` subclass constructs; runtime-only calls throw). Listing commands build the application exactly as the Worker does, with the Cloudflare adapter, but seed `ENV` with the Wrangler `vars` only: no bindings or secrets, so module factories must not do binding I/O at bootstrap. `vela db seed` instead asks the project's Wrangler for local bindings (`getPlatformProxy()`, persisted like `vite dev`). A default export that is neither `defineCloudflareApp(AppModule).worker` nor `createCloudflareWorker(AppModule)` fails with guidance; both forms are valid, and an entry that exports Durable Object classes built from the app should keep `export default app.worker`.

A `vela.config.{js,mjs,ts}` takes precedence when present (the CLI tries those three names, then the Wrangler files, in the current directory; `--config <path>` names one; no parent search). When the project installs Vite 8 (an optional peer; `vela new` projects do), the config and the Worker entry load through the same module runner, which stays open for the whole command; packages still load from node_modules, and neither `vite.config.ts` nor tsconfig path aliases apply. Without Vite, Node imports them: type stripping handles erasable `.ts` syntax but emits no decorators/DI metadata, so import compiled `.js` files with explicit extensions. Pin the CLI as a dev dependency and run it as `pnpm exec vela ...`.

```ts
// vela.config.ts: only when the tools need an application built differently.
import { defineVelaConfig } from '@velajs/cli/config';
import { VelaFactory } from '@velajs/vela';
import { AppModule } from './src/app.module.js';

export default defineVelaConfig({
  createApp: () => VelaFactory.create(AppModule),
  rootModule: AppModule, // used by OpenAPI and client contract generation
});
```

`VelaConfig` requires `createApp` and accepts an optional `rootModule` (a module class or `DynamicModule`); `defineVelaConfig` preserves inferred app subtypes and custom properties. Supply local binding equivalents inside the factory if required. Config may be a default export or a named `config` export. Loading validates callable `createApp` and a `rootModule` that is a module class or a `DynamicModule` of one. `resolveConfig` from `./config` resolves `{path, source: 'explicit' | 'discovered' | 'wrangler', candidates}` without importing code. Commands that bootstrap an app dispose it after success/failure; cleanup warnings preserve the primary result.

## Project commands

| Command | Flags | What it does |
|---|---|---|
| `vela new <name>` | `--template minimal\|api`, `--pm pnpm\|npm\|yarn\|bun`, `--install`, `--git` | Scaffold a Workers project with pinned versions; `api` adds a zod-validated KV resource, a queue processor, a cron job and workerd specs. The package manager defaults to the one running the command |
| `vela generate <schematic> <name>` (alias `g`) | `--path`, `--module`, `--flat`, `--skip-import`, `--dry-run`, `--schedule`, `--binding` | `module`, `controller`, `service`, `resource`, `queue`, `cron`, `durable-object` with current APIs, registered by editing the parent module with oxc-parser + magic-string (comments and formatting kept) |
| `vela add <d1\|kv\|r2\|queue> <BINDING>` | `--name`, `--config`, `--env`, `--skip-import` | Create the resource with the project's Wrangler (`--binding --update-config`; a queue's producer and consumer are added to the JSONC), run the `types` script, then provide the binding from a global `BindingsModule` (`@Inject(DB) db: D1Database`; an existing `bindings.module.ts` keeps its class name) or register `QueueModule.registerQueue({ name, binding })`. A reserved word or a name the bindings module declares or imports is refused before anything is created (the token an earlier run declared for the binding is reused); Wrangler and the CLI edit only `wrangler.json(c)`, so with a `wrangler.toml` the binding (a queue's producer and consumer) is printed under `Manual steps required` and it exits 2 (0 done, apart from what `--skip-import` prints; 1 failed) |
| `vela cf sync` | `--config`, `--env`, `--write`, `--prune`, `--json` | Compare the Wrangler file with the app: a trigger per `@Cron` expression, a producer per registered binding, a consumer per processed or `@QueueConsumer` queue, a binding and `new_sqlite_classes` migration per exported Durable Object (a gateway binding no class serves goes to the one exported `VelaWebSocketDurableObject` class, never a host Durable Object; a Durable Object the app defines but the entry does not export is reported), a `workflows` entry per exported `WorkflowEntrypoint`. Exits 1 on differences; `--write` edits JSON/JSONC through jsonc-parser (comments kept); TOML is compared only. A trigger no `@Cron` job declares is reported and kept (a Worker entry's own `scheduled` handler may serve it) unless `--prune` removes it; other stale entries are reported |

Generators place files in `src/<name>/` and register a controller, service, cron job or processor in the module of that directory (else the nearest one up to the root module the Worker entry passes to `defineCloudflareApp` or `createCloudflareWorker`); a module or resource registers in the module above. The root module is the class the Worker entry names, followed through re-exports and `export *` barrels to the file declaring it; elsewhere, the edited class is the file's exported module class. `queue` also adds `QueueModule.forRoot({ driver: cloudflareQueues() })` to the root module unless some source file already configures the driver; `durable-object` writes `<name>.host.ts` (an `@Injectable()` host injecting `DO_STORAGE`) and a class whose `rpc` lists the host's `increment`: when the Worker entry binds its app (`const app = defineCloudflareApp(...)`) it declares `export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment'] }) {}` in the entry after the app (sharing its adapters); when the entry imports the app from its own module, `<name>.durable-object.ts` imports it; otherwise `<name>.durable-object.ts` builds it from the root module (and the generator notes when the entry passes options it then does not share). A separate class file is exported from the entry with `export { Name } from ...`. Follow a generator or `add` with `vela cf sync --write` and the `types` script.

## Commands

| Command | Flags | What it does |
|---|---|---|
| `vela deploy check` | `--config`, `--env`, `--entrypoints`, `--json` | Check the Wrangler file in the working directory at the top level (or `--env`) against the app's entrypoints: crons, queue producers/consumers, WebSocket Durable Object bindings, guarded direct cron jobs, and `cf:durable-object` rows (warnings `unbound-durable-object`, `unexported-durable-object`, and `durable-object-error-serialization` when an exported host with RPC methods meets a `compatibility_date` before 2026-04-21 without `enhanced_error_serialization`). Without `--entrypoints` the snapshot is computed from the app; with one, no application code is imported |
| `vela doctor` | `--config`, `--env`, `--app`, `--json` | Resolve config without import; opt-in `--app` bootstraps then snapshots app-local modules/routes/entrypoints without resolving lazy providers or emitting arbitrary metadata/values |
| `vela route list` | `--config`, `--env`, `--json` | List HTTP routes (paths incl. prefix/version, named + contributed/CRUD routes, plus `(mounted)` sub-apps) |
| `vela module graph` | `--config`, `--env`, `--json` | Print the module import graph with `global`/`lazy` flags, provider/export counts |
| `vela entrypoint list` | `--config`, `--env`, `--json` | List declared entrypoint kinds (websocket, queue, cron, cf:*, …) and their entries; without a config, `cf:durable-object` rows for the Durable Object classes the Worker entry exports (by export name) and those its app defines but does not export |
| `vela openapi dump` | `--config`, `--env`, `--out`, `--title`, `--api-version`, `--global-prefix` | Emit the OpenAPI document of the root module (the Worker's, a class or `DynamicModule`, or `rootModule` in `vela.config`); `--out` writes to a file, else stdout |
| `vela db seed` | `--config`, `--env`, `--continue-on-error`, `--list`, `--json` | Run each seeder registration in order, or list names/orders/owners without executing seeders (`--json` requires `--list`) |
| `vela mcp serve` | `--config`, `--env` | Start the MCP server over stdio (see below) |

`openapi dump` emits JSON directly. `doctor --app` and seeder inventory still run application startup/shutdown hooks; while a command loads and runs the application, its console output (module-scope code and `Logger` lines included) goes to stderr, so JSON on stdout stays parseable.

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
- `app.getContainer().getModuleDescriptions()` → `ModuleDescription[]` (`{ moduleId, imports, global, lazy, providers, exports }`).
- `app.entrypoints.kinds()` / `app.entrypoints.ofKind(kind)` → declared non-HTTP entry surfaces.
- `app.getGlobalPrefix()` → the configured prefix.
- `describeToken(token)` (a `@velajs/vela` free function) → a human-readable token label.
- `createOpenApiDocument(rootModule, { globalPrefix?, info?, tags? })` → the OpenAPI document (see `references/openapi.md`).
- `runSeeders(app, { stopOnError })` (from `@velajs/vela/seeder`) backs `vela db seed` (see `references/seeders.md`).
