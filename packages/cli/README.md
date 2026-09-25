# @velajs/cli

Node-side command-line tools for [Vela](https://github.com/velajs/vela) apps. Runs
outside the edge Worker (it uses `node:*` / `process`), so it stays out of your
Worker bundle.

## Install

```bash
pnpm add -D @velajs/cli
```

## Commands

| Command | What it does |
| --- | --- |
| `vela new my-api` | Create a Workers project (`--template minimal` or `api`, `--pm pnpm\|npm\|yarn\|bun`, `--install`, `--git`). |
| `vela generate <schematic> <name>` | Alias `vela g`. Generate a `module`, `controller`, `service`, `resource`, `queue`, `cron`, `durable-object`, `workflow` or `entrypoint` and register it in the parent module or the Worker entry. |
| `vela add <d1\|kv\|r2\|queue> <BINDING>` | Create the resource with the project's Wrangler, refresh the binding types and register the binding in the application. |
| `vela cf sync` | Compare the Wrangler file with the application's cron triggers, queues, Durable Objects and Workflows; `--write` updates JSON/JSONC in place. |
| `vela deploy check` | Check the Wrangler target (top level, or `--env`) against the application's entrypoints without building or deploying. See the [deployment guide](../../docs/deployment.md). |
| `vela doctor` | Explain how the application is found without importing it; `--app` opts into application graph snapshots and teardown. Supports `--json`. |
| `vela db seed` | Build the app with Wrangler's local bindings and run all `@Seeder()` classes in order. |
| `vela route list` | HTTP route table: framework-composed controller routes (`Controller#handler`, full paths incl. prefix/version) plus `(mounted)` extras (CRUD/contributed, doc UIs). |
| `vela module graph` | Module graph: imports tree with `global`/`lazy` flags and provider counts (`--json` for the raw graph). |
| `vela entrypoint list` | Declared entrypoint kinds (websocket, queue, cron, …) and their entries — lazy modules stay unmaterialized. |
| `vela openapi dump` | Emit the OpenAPI document (`--out`, `--title`, `--api-version`, `--global-prefix`). |
| `vela client generate` | Generate an `AppType` for `hc` from the app or `--input openapi.json`; `--out`, `--strict`, and CI `--check`. |
| `vela mcp serve` | Run a Model Context Protocol stdio server exposing the introspection above as read-only tools (`route_list`, `module_graph`, `entrypoint_list`, `openapi_dump`, `token_describe`) plus a `vela://openapi` resource — for AI agents. |
| `vela studio` | Serve the optional Studio UI through a local host, proxying the app selected by `--url`. |

The commands that build the application take `--config <path>` (a `vela.config`) and `--env <name>` (a Wrangler environment); the listing commands also take `--json`. While a command loads and runs the application, the application's console output (module-scope code of the config or Worker entry and `Logger` lines included) goes to stderr, so stdout holds only the command's output.

### Create a project

Requires Node.js 24+:

```sh
pnpm dlx @velajs/cli@latest new my-api
cd my-api
pnpm install
pnpm run dev
```

Request `http://localhost:5173` to receive `{"message":"Hello from Vela!"}`.
The greeting comes from a constructor-injected service. Vite 8 and
`@cloudflare/vite-plugin` serve, build (`pnpm run build`) and deploy
(`pnpm run deploy`) `src/worker.ts` with no separate compile step; Oxc emits the
legacy decorators and constructor metadata, configured once in `oxc.config.ts`
for both `vite.config.ts` and `vitest.config.ts`. `pnpm run test` runs the
included spec inside workerd: `createTestingWorker()` from
`@velajs/cloudflare/testing` builds the module as the Worker does. `src/worker.ts`
is only `export default createCloudflareWorker(AppModule)`: providers read
bindings through the framework `ENV`, typed from the `worker-configuration.d.ts`
that the `types` script (`wrangler types --include-runtime=false`) regenerates,
also before `dev` and `typecheck`. The project pins this CLI as a dev
dependency, so `pnpm exec vela route list` works immediately, without a config
file. The generated application uses published npm dependencies and requires no
Cloudflare login.

| Option | Effect |
| --- | --- |
| `--template minimal` | The default: one module, controller and injected service. |
| `--template api` | A todos resource validated with zod and stored in Workers KV, a `todo-events` queue processor, a nightly `@Cron` job, `OpenApiModule` serving `/openapi.json`, and specs that drive `fetch`, `queue()` and `scheduled()`. |
| `--pm pnpm\|npm\|yarn\|bun` | The package manager the files and instructions use; by default the one running the command, else pnpm. pnpm projects get `pnpm-workspace.yaml` build approvals, Yarn projects `nodeLinker: node-modules`, Bun projects `trustedDependencies`. |
| `--install` | Run the package manager's install in the new directory. |
| `--git` | `git init` and commit the project as `chore: initial commit`. |

With an installed CLI, use `vela new my-api`. Names start with a lowercase letter
and contain lowercase letters, digits, or single hyphens (at most 63 characters).
Paths and reserved device names are rejected. Existing empty directories are
accepted; nonempty directories, files, and symbolic links are rejected without
overwriting them.

See the [project creation guide](https://github.com/velajs/vela/blob/main/docs/getting-started.md)
and the [tooling guide](https://github.com/velajs/vela/blob/main/docs/tooling.md#the-cli-loop).

### Generate code

```sh
vela g resource notes                       # src/notes/: module, controller, service, schemas
vela g module billing                       # imported into the module above
vela g controller billing                   # registered in src/billing/billing.module.ts
vela g queue emails --binding EMAIL_QUEUE   # @Processor + QueueModule.registerQueue(); the driver once
vela g cron digest --schedule "0 6 * * *"   # @Cron(..., { dialect: 'cloudflare' })
vela g durable-object counter               # exported from the Worker entry
vela g workflow signup                      # a Workflow built from the entry's app
vela g entrypoint billing                   # a service entrypoint (WorkerEntrypoint)
vela g service audit --skip-import          # prints the registration instead
```

Files go to `src/<name>/` (`--path`, `--flat`). A controller, service, cron job
or processor registers in the module of its directory, else the nearest module up
to the root module the Worker entry passes to `createCloudflareWorker()`
(`--module` names one); a module or resource registers in the module above.
The root module is followed through `export { … } from` re-exports and
`export *` barrels to the file declaring it, where the class the Worker entry
names is edited (else that file's only module class); elsewhere, the file's
exported module class. A queue adds the `cloudflareQueues()` driver
to the root module only when no source file configures `QueueModule.forRoot()`
yet. Module files are edited with `oxc-parser` and `magic-string`, so comments
and formatting stay as they are (a comment trailing the last entry stays on
it); a name imported with `import type` becomes a value import when the
registration needs it. A module whose metadata is computed, or spreads or
computes a key that may set the list, is refused with nothing written.
Generated code uses the application kit, feature subpaths
(`@velajs/vela/queue`, `@velajs/vela/schedule`), `ENV`, and plain decorator
routes; a resource validates bodies with zod when the project depends
on it, and with generated parse functions otherwise. A `workflow` or
`entrypoint` writes an `@Injectable()` host and declares
`VelaWorkflow(app, SignupHost)` or `VelaEntrypoint(app, BillingHost, { rpc: ['ping'] })`
after the Worker entry's app: both run in the Worker's application, so an
entry that default-exports `createCloudflareWorker(AppModule, options)` first
becomes `const app = defineCloudflareApp(AppModule, options); export default app.worker;`.
Existing files are never overwritten; `--dry-run` lists the changes.

### Add Cloudflare resources

```sh
vela add d1 DB          # wrangler d1 create <worker>-db --binding DB --update-config
vela add kv CACHE --name shop-cache
vela add r2 UPLOADS
vela add queue EMAILS   # wrangler queues create <worker>-emails; producer and consumer in wrangler.jsonc
```

`add` runs the project's Wrangler (creating a resource needs `wrangler login`),
registers the binding, then runs the project's `types` script: D1, KV and R2
bindings become injection tokens of a global `BindingsModule` next to the root
module (`constructor(@Inject(DB) db: D1Database)`), and a queue becomes
`QueueModule.registerQueue({ name, binding })`, with the `cloudflareQueues()`
driver added to the root module unless a module already configures it.
`--config <file>` is passed on to Wrangler. Every module edit, and a queue's
Wrangler file edit, is computed before anything is created, so a root module,
`bindings.module.ts` or Wrangler file the CLI cannot edit fails with nothing
created; a failed type refresh only warns. A D1, KV or R2 `BINDING` that is a
JavaScript reserved word, or a name `bindings.module.ts` declares (a class,
function, variable or enum) or imports (`ENV`, `Global`, `InjectionToken`,
`Module`, `defineProvider` or its module class), is refused first; the
`InjectionToken` an earlier `vela add` declared for that binding is reused. An
existing `bindings.module.ts` keeps its class name, and a root module that
already lists it through a path alias or a barrel is left as it is. Wrangler
and the CLI edit `wrangler.json` and `wrangler.jsonc` only: with a
`wrangler.toml`, the resource is created and registered, but its binding (for a
queue, its producer and consumer) is printed under `Manual steps required` and
the command exits 2. Exit code 0 means everything was applied, apart from the
registration `--skip-import` prints; 1 means the command failed. Source edits
keep CRLF files CRLF. `--skip-import` prints the registration instead and needs
no editable root.

### Keep Wrangler in sync

```sh
vela cf sync            # exit 1 and list the differences
vela cf sync --write    # apply them to wrangler.jsonc, keeping comments
vela cf sync --write --prune   # also remove cron triggers no @Cron job declares
vela cf sync --env staging --write
```

The application declares what the Worker needs: a cron trigger per `@Cron`
expression, a queue producer per `QueueModule.registerQueue({ binding })`, a
consumer per processed or `@QueueConsumer` queue, a Durable Object binding and a
`new_sqlite_classes` migration per exported Durable Object class, and a
`workflows` entry per exported `WorkflowEntrypoint` (Vela Workflows included).
It warns about a Durable Object, Workflow or service entrypoint class the app
defines but the entry does not export, naming the call that defined it (export
that class), and about a service binding to an `entrypoint` of this Worker
that the entry does not export. `--write` edits JSON and
JSONC files through `jsonc-parser`; a `wrangler.toml` is only compared. A cron
trigger no `@Cron` job declares is reported as such and kept, since a Worker entry
with its own `scheduled` handler may serve it; `--prune` removes those triggers.
Anything else the application does not use is reported and left in place. Run the
`types` script afterwards.

### MCP server

`vela mcp serve` builds the app (see [Configure](#configure)) and speaks the [Model Context
Protocol](https://modelcontextprotocol.io) over stdio, so an AI agent can query
the app's shape. It exposes read-only tools — `route_list`, `module_graph`
(`{ tree? }`), `entrypoint_list`, `openapi_dump` (`{ globalPrefix?, title?,
apiVersion? }`, needs `rootModule`), `token_describe` (`{ token }`) — and, when
`rootModule` is set, a `vela://openapi` resource. Tool results are JSON text.
stdout carries only JSON-RPC; all logging goes to stderr. The server runs until
the client disconnects, then disposes the app.

```jsonc
// e.g. in an MCP client config
{
  "mcpServers": {
    "vela": { "command": "vela", "args": ["mcp", "serve"] }
  }
}
```

## Configure

No configuration is needed in a Workers project. Without a `vela.config`, the
CLI reads `main` from `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` in the
current directory (`--env` picks a named environment), loads that Worker entry
through a Vite module runner with Oxc's legacy decorators and decorator
metadata, and builds the application `createCloudflareWorker(AppModule,
options)` describes: the descriptor it attaches under
`Symbol.for('vela.cloudflare.worker')` carries the root module and options.
`cloudflare:*` imports resolve to inert Node stand-ins, so a Worker entry that
exports Durable Object, Workflow or entrypoint classes loads too. Commands that list or
check the application seed `ENV` with the Wrangler `vars` only, never bindings or
secrets: keep binding I/O out of bootstrap. `vela db seed` uses Wrangler's
`getPlatformProxy()` local bindings, persisted like `vite dev`.

Create a `vela.config.{js,mjs,ts}` when the tools need an application built
differently, for example with local binding equivalents. When the project
installs Vite 8 (an optional peer dependency; the starter does), the config loads
through the same module runner, so it imports the decorated application source
directly, at the top level or lazily inside `createApp()`. The runner stays open
for the whole command:

```ts
// vela.config.ts
import { defineVelaConfig } from '@velajs/cli/config';
import { VelaFactory } from '@velajs/vela';
import { AppModule } from './src/app.module.js';

export default defineVelaConfig({
  rootModule: AppModule, // needed by `vela openapi dump` and `vela client generate`
  createApp: () => VelaFactory.create(AppModule),
});
```

For a Worker whose modules need bindings while the application builds, pass the
bindings Wrangler's `getPlatformProxy()` provides through
`cloudflareAdapter({ env })`, and close the proxy once the app is disposed; the
[API starter](../../apps/api-starter/vela.config.ts) does this. A plain
default-exported object or named `config` export also works; `defineVelaConfig`
preserves the inferred app subtype and custom fields. The loader validates
`createApp` and optional `rootModule` before commands use them. Command teardown
awaits application disposal even when work fails, then closes the module runner,
and cleanup warnings do not replace the command's exit result.

Through Vite, the config and the relative files it imports are transformed;
packages load from `node_modules` as usual. Vite's own project config
(`vite.config.ts`) is not applied, and `tsconfig` path aliases are not resolved.

Without Vite 8, the CLI imports the config with Node. Node 24 can strip erasable
types in a `.ts` config, but it does not transform legacy decorators, emit
constructor metadata, or resolve `tsconfig` path aliases, so such a config must
import compiled `.js` files with explicit extensions (for example the output of
a metadata-emitting compiler). See [Node's TypeScript documentation](https://nodejs.org/docs/latest-v24.x/api/typescript.html#typescript-features).

The loader checks `vela.config.js`, then `.mjs`, then `.ts`, then the Wrangler
files in the current directory; it does not search parents. `--config` selects
exactly that path, relative to the current directory or absolute, with no
fallback to another file. `resolveConfig()` from `@velajs/cli/config` returns the
selected absolute path, the `explicit`/`discovered`/`wrangler` source and the
candidates actually checked, without importing user code. `loadConfig(cwd,
config?, { environment?, bindings? })` imports it and resolves to
`{ config, path, source, importModule, dispose }`; call `dispose()` after
disposing the app to close the module runner.

### Diagnose configuration

```sh
vela doctor --json
vela doctor --app --json
```

The default only resolves the config (or Wrangler) file. `--app` imports it and runs normal
application bootstrap and shutdown hooks, which may perform application-defined
work. It then reads existing module, route and entrypoint descriptions without
resolving providers or materializing lazy modules for inspection. Reports omit
provider values, environment values and arbitrary entrypoint metadata, and show
only entrypoints belonging to that app. `--json` uses `schemaVersion: 1`; missing
configs, bootstrap/snapshot errors or cleanup warnings return exit code 1.
Send application startup logs to stderr when consuming JSON output.

For breakpoints and source maps, see the [debugging guide](../../docs/debugging.md).

### Studio

```sh
vela studio --url http://127.0.0.1:8787 --port 4000
```

The optional `@velajs/studio-host` and `@velajs/studio-ui` packages provide the
host and UI. `--port` accepts a decimal integer from 0 to 65535 (0 asks the OS
for an available port). Tokens come from `--token` or `VELA_STUDIO_TOKEN` and are
injected by the host. The CLI config and client-generation entrypoints remain
usable without Studio installed.

## Commands

```bash
# Run all @Seeder() classes (see @velajs/vela/seeder), in order, against the
# local bindings Wrangler's getPlatformProxy() provides (or a vela.config app):
vela db seed
vela db seed --env staging
vela db seed --config ./config/vela.config.js
vela db seed --continue-on-error
# Inspect registration owners without running seeders:
vela db seed --list --json
```

Exit code is `0` when all seeders run and `1` if any fail.
Seeders registered in multiple modules run once per owner, including async
providers. Invocations finish their managed deferred work and dispose request
resources before the next seeder starts. See [seeding](../../docs/seeding.md).

## Typed HTTP clients

```sh
vela client generate --out src/api.generated.ts --strict
vela client generate --out src/api.generated.ts --strict --check
# Without bootstrapping an app:
vela client generate --input openapi.json --out src/api.generated.ts
```

The generated file imports `HttpApp` from `@velajs/client/http`. JSON-only contracts contain only types; form contracts also export `formEncodings`. On the frontend:

```ts nocheck
import { hc } from '@velajs/client/http';
import type { AppType } from './api.generated';

const client = hc<AppType>('https://api.example.com');
const response = await client.users[':id'].$get({ param: { id: 'u1' } });
const user = await response.json();
```

Generate with the current Vela exporter to include global prefixes, route versions, `@HttpCode`, and query DTO fields. Use the server origin for `hc`; prefixes are already in the generated paths. Route options (`@Post({ response, status })` with `@Body(schema)`) and `defineRoute` contracts share schemas with runtime validation, and generate the same client. Named `defineDto` descriptors passed to parameter decorators such as `@Body(dto)`, to `ValidationPipe`, and to `@ApiResponse` also supply documentation types; erased TypeScript interfaces and handler return types cannot be recovered from decorators. Missing schemas produce `unknown` and stderr warnings. `--strict` fails on these warnings before writing, and `--check` verifies the exact generated file without changing it. `@All` handlers, such as a mounted auth handler, have no OpenAPI operation, so the contract and its check against the app's routes leave them out.

Form routes declare `body: { multipart }` or `body: { form }` with a
`@Body(schema)` form schema (or `multipart`/`form` on a `defineRoute` contract). The generator emits
string/file fields and repeated arrays with required/optional properties, retaining
all response variants. Files become `File | Blob` only for multipart contracts.
Use `fetch: withFormEncoding(formEncodings, suppliedFetch)` from
`@velajs/client/http` so URL-encoded routes use their declared encoding;
bare `hc` always serializes forms as multipart. Wrap per-call fetch overrides too.
Custom part encodings, nested form values, and binary JSON bodies fail generation
with diagnostics. See the [HTTP guide](../../docs/client/HTTP.md#form-bodies-and-uploads).

Supported: JSON bodies, JSON/text and binary/stream/native responses with status narrowing, string path/query/header inputs, repeated query arrays, component references, object/array/enum/union/intersection/nullable schemas. Unsupported encodings, custom serialization and unresolved references fail with a diagnostic. Global middleware/error responses must be documented or added with Hono's `ApplyGlobalResponse`. Generation does not validate server responses at runtime. Raw Hono mounts and live-query resolver contracts are not inferred.

Native endpoint formats export `x-vela-response-format` with the declared media
type. Generated binary/stream calls expose blob/byte-stream consumption and keep
`.json()` unknown. Imported event-stream/NDJSON media and binary schemas are
recognized; multiple response media types use an unknown native contract. Use
`readHttpResponse` from `@velajs/client/http` to retain the response, consume a
blob, or access an unread stream. See the [HTTP guide](../../docs/client/HTTP.md).
