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

## Development

Use Node 24 or later and pnpm 11.11.0. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm build
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
infer their real output. See [the core type guide](vela/TYPE_CONTRACTS.md).

## Runnable examples

- [Complete auth, D1 CRUD, generated client, live and Studio starter](cloudflare/examples/api-starter/README.md)
- [Native Workers bindings](cloudflare/examples/worker-bindings-lab/README.md)
- [Live todos on Workers and Node](vela/examples/live-todo/README.md)
- [Better Auth with D1](auth/examples/auth-lab-d1/README.md)
- [Studio demonstration](studio/examples/demo/README.md)
- [Testing harness](testing/examples/lab-testing-harness/README.md)

AI, agents, email, and workflow packages remain outside this API workspace.

The coordinated 2.0 release process and migration notes are in [RELEASING.md](RELEASING.md).
