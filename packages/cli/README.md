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
| `vela new my-api` | Create a minimal Workers project with a module, controller, injected service, and a working local development setup. |
| `vela doctor` | Explain config resolution without importing it; `--app` opts into application graph snapshots and teardown. Supports `--json`. |
| `vela deploy check` | Check an explicit Wrangler config/environment against a saved entrypoint snapshot without bootstrapping, building or deploying. See the [deployment guide](../../docs/deployment.md). |
| `vela db seed` | Build the app and run all `@Seeder()` classes in order. |
| `vela route list` | HTTP route table: framework-composed controller routes (`Controller#handler`, full paths incl. prefix/version) plus `(mounted)` extras (CRUD/contributed, doc UIs). |
| `vela module graph` | Module graph: imports tree with `global`/`lazy` flags and provider counts (`--json` for the raw graph). |
| `vela entrypoint list` | Declared entrypoint kinds (websocket, queue, cron, …) and their entries — lazy modules stay unmaterialized. |
| `vela openapi dump` | Emit the OpenAPI document (needs `rootModule` in the config; `--out`, `--title`, `--api-version`, `--global-prefix`). |
| `vela client generate` | Generate an `AppType` for `hc` from the app or `--input openapi.json`; `--out`, `--strict`, and CI `--check`. |
| `vela mcp serve` | Run a Model Context Protocol stdio server exposing the introspection above as read-only tools (`route_list`, `module_graph`, `entrypoint_list`, `openapi_dump`, `token_describe`) plus a `vela://openapi` resource — for AI agents. |
| `vela studio` | Serve the optional Studio UI through a local host, proxying the app selected by `--url`. |

All introspection commands take `--config <path>`; the listing commands also take `--json`.

### Create a project

Requires Node.js 24+ and pnpm 11.11.0:

```sh
pnpm dlx @velajs/cli@latest new my-api
cd my-api
pnpm install
pnpm typecheck
pnpm build
pnpm dev
```

Request `http://localhost:8787` to receive `{"message":"Hello from Vela!"}`.
The greeting comes from a constructor-injected service. SWC emits decorator
metadata, and Wrangler rebuilds source changes during local development.
`src/worker.ts` is only `export default createCloudflareWorker(AppModule)`:
providers read bindings through the framework `ENV`, typed from the
`worker-configuration.d.ts` that `pnpm types` (`wrangler types
--include-runtime=false`) regenerates before `pnpm dev` and `pnpm typecheck`.
The generated application uses published npm dependencies and requires no
Cloudflare login, authentication integration, D1, Studio, or live queries.

With an installed CLI, use `vela new my-api`. Names start with a lowercase letter
and contain lowercase letters, digits, or single hyphens (at most 63 characters).
Paths and reserved device names are rejected. Existing empty directories are
accepted; nonempty directories, files, and symbolic links are rejected without
overwriting them. Creation does not install dependencies or initialize Git.

See the [project creation guide](https://github.com/velajs/vela/blob/main/docs/getting-started.md).
Module, controller, service, and resource generators are not included yet.

### MCP server

`vela mcp serve` builds the app from `vela.config` and speaks the [Model Context
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

Create a `vela.config.{js,mjs,ts}` at your project root that builds your app.
Import compiled application JavaScript, including its decorator metadata. The
starter's SWC build produces these files in `dist/`; run `pnpm build` first.
This minimal config uses the portable factory in Node:

```js
// vela.config.mjs
import { defineVelaConfig } from '@velajs/cli/config';
import { VelaFactory } from '@velajs/vela';
import { AppModule } from './dist/app.module.js';

export default defineVelaConfig({
  rootModule: AppModule, // needed by `vela openapi dump` and `vela client generate`
  createApp: () => VelaFactory.create(AppModule),
});
```

Supply local runtime bindings inside `createApp` if the application needs them.
Do not import the Worker entrypoint into Node when it uses native
`cloudflare:workers` APIs. A plain default-exported object or named `config`
export also works; `defineVelaConfig` preserves the inferred app subtype and
custom fields. The loader validates `createApp` and optional `rootModule` before
commands use them. Command teardown awaits application disposal even when work
fails, and cleanup warnings do not replace the command's exit result.

Node 24 can strip erasable types in a `.ts` config, but it does not transform
legacy decorators, emit constructor metadata, or resolve `tsconfig` path
aliases. A `.ts` config should therefore also import the compiled `.js` graph
with explicit extensions. Use SWC's `legacyDecorator` and `decoratorMetadata`
settings from the starter, or a compiler with equivalent output. The CLI adds
no compiler hooks. See [Node's TypeScript documentation](https://nodejs.org/docs/latest-v24.x/api/typescript.html#typescript-features).

The loader checks `vela.config.js`, then `.mjs`, then `.ts` in the current
directory; it does not search parents. `--config` selects exactly that path,
relative to the current directory or absolute, with no fallback to another file.
`resolveConfig()` from `@velajs/cli/config` returns the selected absolute path,
the `explicit`/`discovered` source and the candidates actually checked, without
importing user code.

### Diagnose configuration

```sh
vela doctor --json
pnpm build
vela doctor --app --config vela.config.mjs --json
```

The default only resolves the config file. `--app` imports it and runs normal
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
# Run all @Seeder() classes (see @velajs/vela/seeder), in order:
vela db seed
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

```ts
import { hc } from '@velajs/client/http';
import type { AppType } from './api.generated';

const client = hc<AppType>('https://api.example.com');
const response = await client.users[':id'].$get({ param: { id: 'u1' } });
const user = await response.json();
```

Generate with the current Vela exporter to include global prefixes, route versions, `@HttpCode`, and query DTO fields. Use the server origin for `hc`; prefixes are already in the generated paths. `@Endpoint(defineEndpoint({ input, output, status }))` shares schemas with runtime validation. Named `defineDto` descriptors passed to parameter decorators such as `@Body(dto)`, to `ValidationPipe`, and to `@ApiResponse` also supply documentation types; erased TypeScript interfaces and handler return types cannot be recovered from decorators. Missing schemas produce `unknown` and stderr warnings. `--strict` fails on these warnings before writing, and `--check` verifies the exact generated file without changing it.

Form endpoints use `input.form` with `body.contentType` set to
`multipart/form-data` or `application/x-www-form-urlencoded`. The generator emits
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
