# Vela

Nest-style modules, controllers, dependency injection, and request pipelines on
Cloudflare Workers. Hono owns HTTP routing and the HTTP RPC client. Studio operates
the running API; the live subsystem owns subscriptions, deltas, and reconnects.

[DESIGN.md](DESIGN.md) defines the intended developer experience and its acceptance
criteria independently of the current package/repository layout.

This is the development monorepo for Vela, its Cloudflare adapter, clients, and
Studio. All packages share one Git history, pnpm workspace, lockfile, and CI.
See [the migration record](docs/migration/monorepo.md) for the imported histories
and [MODERNIZATION.md](MODERNIZATION.md) for implementation and validation history.

## Workspace layout

- `packages/*`: publishable libraries and shared Studio test fixtures.
- `apps/*`: runnable Workers applications and integration examples.
- `tools/docs`: isolated API documentation tooling.
- `tools/tsconfig`: shared compiler configurations.
- `tests/crud`: cross-adapter conformance; `tests/release`: release safety checks.
- `examples/legacy`: historical examples excluded from the workspace.

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
provide Rust-based linting and formatting; tsdown uses Rolldown/Oxc, and SWC
preserves the decorator metadata used by dependency injection. TypeScript 7's
native compiler is written in Go. Root `lint`, `format`, and `format:check`
commands share one configuration, and dependency versions use the pnpm catalog.

TypeDoc still requires the TypeScript 6 compiler API, so its compatibility
dependency is isolated in `tools/docs`. It is used only for API documentation; package builds and typechecks use
the shared TypeScript 7 toolchain. See [the tooling comparison](docs/tooling.md).

## Authoring model

- **Application modules:** classes or checked `defineProvider` descriptors,
  explicit imports/exports, and token-inferred resolution.
- **Native platform:** an `InjectionToken<Env>` makes generated Workers bindings
  available before providers and lifecycle hooks run. `createCloudflareWorker`
  exports the Worker handlers and shares bootstrap per environment identity.
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

Schema descriptors replace DTO constructors that claimed uninitialized fields.
Cache reads and other unvalidated values return `unknown`; parser-based helpers
infer their real output. See [the core type guide](packages/vela/TYPE_CONTRACTS.md).

## Runnable examples

- [Complete auth, D1 CRUD, generated client, live and Studio starter](apps/api-starter/README.md)
- [Native Workers bindings](apps/worker-bindings-lab/README.md)
- [Live todos on Workers and Node](apps/live-todo/README.md)
- [Better Auth with D1](apps/auth-lab-d1/README.md)
- [Studio demonstration](apps/studio-demo/README.md)
- [Testing harness](apps/lab-testing-harness/README.md)

AI, agents, email, and workflow packages remain outside this API workspace.

The coordinated 2.0 release process and migration notes are in [RELEASING.md](RELEASING.md).
