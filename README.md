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
| `vela db seed` | Build the app and run all `@Seeder()` classes in order. |
| `vela route list` | HTTP route table: framework-composed controller routes (`Controller#handler`, full paths incl. prefix/version) plus `(mounted)` extras (CRUD/contributed, doc UIs). |
| `vela module graph` | Module graph: imports tree with `global`/`lazy` flags and provider counts (`--json` for the raw graph). |
| `vela entrypoint list` | Declared entrypoint kinds (websocket, queue, cron, …) and their entries — lazy modules stay unmaterialized. |
| `vela openapi dump` | Emit the OpenAPI document (needs `rootModule` in the config; `--out`, `--title`, `--api-version`, `--global-prefix`). |
| `vela client generate` | Generate an `AppType` for `hc` from the app or `--input openapi.json`; `--out`, `--strict`, and CI `--check`. |
| `vela mcp serve` | Run a Model Context Protocol stdio server exposing the introspection above as read-only tools (`route_list`, `module_graph`, `entrypoint_list`, `openapi_dump`, `token_describe`) plus a `vela://openapi` resource — for AI agents. |

All introspection commands take `--config <path>`; the four listing/dump commands also take `--json`.

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
Wire your runtime bindings here (e.g. via miniflare for Cloudflare, or a Node
adapter):

```ts
// vela.config.ts
import { defineVelaConfig } from '@velajs/cli/config';
import { AppModule } from './src/app.module';

export default defineVelaConfig({
  rootModule: AppModule, // needed by `vela openapi dump` and `vela client generate`
  async createApp() {
    const { createCloudflareApp } = await import('@velajs/cloudflare');
    return createCloudflareApp(AppModule);
  },
});
```

> `.ts` configs require a runtime that strips types (Node 22+
> `--experimental-strip-types`, or `tsx`). `.js`/`.mjs` load directly.

## Commands

```bash
# Run all @Seeder() classes (see @velajs/vela/seeder), in order:
vela db seed
vela db seed --config ./config/vela.config.js
vela db seed --continue-on-error
```

Exit code is `0` when all seeders run and `1` if any fail.

## Typed HTTP clients

```sh
vela client generate --out src/api.generated.ts --strict
vela client generate --out src/api.generated.ts --strict --check
# Without bootstrapping an app:
vela client generate --input openapi.json --out src/api.generated.ts
```

The generated file contains only types and imports `HttpApp` from `@velajs/client/http`. On the frontend:

```ts
import { hc } from '@velajs/client/http';
import type { AppType } from './api.generated';

const client = hc<AppType>('https://api.example.com');
const response = await client.users[':id'].$get({ param: { id: 'u1' } });
const user = await response.json();
```

Generate with the current Vela exporter to include global prefixes, route versions, `@HttpCode`, and query DTO fields. Use the server origin for `hc`; prefixes are already in the generated paths. `@Endpoint(defineEndpoint({ input, output, status }))` shares schemas with runtime validation. Named `defineDto` descriptors passed to `ValidationPipe` and `@ApiResponse` also supply documentation types; erased TypeScript interfaces and handler return types cannot be recovered from decorators. Missing schemas produce `unknown` and stderr warnings. `--strict` fails on these warnings before writing, and `--check` verifies the exact generated file without changing it.

Supported: JSON bodies, JSON/text responses with status narrowing, string path/query/header inputs, repeated query arrays, component references, object/array/enum/union/intersection/nullable schemas. Unsupported encodings, custom serialization and unresolved references fail with a diagnostic. Global middleware/error responses must be documented or added with Hono's `ApplyGlobalResponse`. Generation does not validate server responses at runtime. Raw Hono mounts and live-query resolver contracts are not inferred.
