# Vela

Nest-style modules, controllers, dependency injection, and request pipelines on
Cloudflare Workers. Hono owns HTTP routing and the HTTP RPC client. Studio operates
the running API; the live subsystem owns subscriptions, deltas, and reconnects.

## Getting started

```sh
pnpm dlx @velajs/cli@latest new my-api
cd my-api
pnpm install
pnpm dev
```

With Node.js 24+ and pnpm 11.11.0, this creates a small module, controller, and
injected service. Request `http://localhost:5173` to see its JSON greeting;
local development needs no Cloudflare login. See the
[project creation guide](docs/getting-started.md) for typechecking, Vite builds, tests,
and the generated project structure.

Continue with the [framework guide](packages/vela/README.md) and
[Cloudflare integration](packages/cloudflare/README.md). The
[API starter](apps/api-starter/README.md) is a runnable example with authentication,
D1, live queries, and Studio. Browse the [documentation](docs/README.md) for
module authoring, types, security, WebSockets, and live-query guides.

For development setup, testing, and pull requests, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Workspace layout

- `packages/*`: publishable libraries and shared Studio test fixtures.
- `apps/*`: runnable Workers applications and integration examples.
- `tools/tsconfig`: shared compiler configurations.
- `tests/crud`: cross-adapter conformance; `tests/release`: release safety checks.

The website lives in the separate [velajs/site](https://github.com/velajs/site)
repository. A local `site/` checkout is ignored and stays outside this workspace.

## Development

Use Node 24 or later and pnpm 11.11.0. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm verify
```

`pnpm verify` builds packages in dependency order, checks types, runs package
suites and CRUD conformance, then runs real Workers tests. Platform tests use the
installed Cloudflare Vitest plugin and Workerd, without a runtime override.

Package commands use the shared root lockfile. For focused work:

```sh
pnpm --filter @velajs/vela test
pnpm --filter @velajs/cloudflare test:workers
pnpm test:conformance
```

## Tooling

TypeScript **7.0.2** checks all active packages and applications. Oxlint and Oxfmt
provide Rust-based linting and formatting; tsdown uses Rolldown/Oxc, and the
`vela new` starter builds with Vite 8, whose Oxc transformer emits the decorator
metadata used by dependency injection. TypeScript 7's native compiler is written
in Go. Root `lint`, `format`, and `format:check`
commands share one configuration, and dependency versions use the pnpm catalog.

The documentation website uses Fumadocs and TypeScript 7 in the separate private
[velajs/site](https://github.com/velajs/site) repository. It provides guides,
selected API type tables, checked examples, and type hovers from published Vela
packages. See [the tooling guide](docs/tooling.md) for coverage and validation.

## Authoring model

- **Application modules:** classes or checked `defineProvider` descriptors,
  explicit imports/exports, and token-inferred resolution.
- **Native platform:** the framework-owned `ENV` token carries the Workers
  bindings, typed by `wrangler types`, before providers and lifecycle hooks run.
  `export default createCloudflareWorker(AppModule)` exports the Worker handlers
  and shares bootstrap per environment identity.
- **HTTP contract:** `defineEndpoint` connects a controller's input and output
  schemas to runtime validation, OpenAPI, and upstream Hono `hc` types.
- **CRUD:** model schemas determine row types, adapters validate returned rows,
  and D1 distinguishes request scope from atomic transaction capability.
- **Authentication:** one verified request identity drives provider-independent
  permission guards and tenant/expiry checks.
- **Live contract:** shared argument/result parsers are consumed by server query
  handlers and the client, with per-application drivers and cursor logs.
- **Studio:** its host authorizes a local operation and sends try-it through the
  actual API HTTP boundary. Operation responses are validated by shared schemas.

Schema descriptors validate data at runtime and infer parsed result types.
Cache reads and other unvalidated values return `unknown`; parser-based helpers
infer their real output. See [the core type guide](docs/types.md).

## Runnable examples

- [Complete auth, D1 CRUD, generated client, live and Studio starter](apps/api-starter/README.md)
- [Native Workers bindings](apps/worker-bindings-lab/README.md)
- [Live todos on Workers and Node](apps/live-todo/README.md)
- [Better Auth with D1](apps/auth-lab-d1/README.md)
- [Studio demonstration](apps/studio-demo/README.md)
- [Testing harness](apps/lab-testing-harness/README.md)
- [Inventory from domain history](apps/event-sourcing-inventory/README.md)

Packages use the 1.x release line. The release process and current API
requirements are in [RELEASING.md](RELEASING.md).
GitHub Actions publishes public npm packages through OIDC with signed source
provenance.
