# Modules across Workers

A runnable four-worker application: the public API calls private catalog and
account modules over HTTP RPC and named native service bindings, and sends queue jobs to a
background worker. The background module also receives native cron triggers.

```sh
pnpm --filter @velajs/example-module-workers build
pnpm --filter @velajs/example-module-workers typecheck
pnpm --filter @velajs/example-module-workers test:workers
pnpm --filter @velajs/example-module-workers dev
```

`GET /api/document` composes the two service results. `POST /api/tasks` submits a
job. `POST /api/native` calls the named `Catalog` entrypoint. Its explicit
`Authenticate`, `TenantGuard`, `PermissionGuard`, `CedarGuard` pipeline verifies
an opaque fixture credential through the named `Identity` binding, checks tenant
membership through `Membership`, and authorizes the canonical identity. Use
`{"credential":"fixture-alice","tenantId":"team-a","documentId":"document-a"}`
for a local successful call. The credential records and policy callbacks are
synthetic fixtures; production adapters verify their own credentials and grants.
`RESULTS` KV records queue and cron completion for this synthetic example.

One `vite.config.ts` builds all four Workers with `@cloudflare/vite-plugin`: the
API is the entry Worker and the other three are auxiliary Workers, each with its
own Wrangler file whose `main` is its TypeScript source. `dev` runs the four in
one workerd process on Vite's port 5173, with the service and queue bindings
between them. `build` bundles each Worker on its own into `dist/<environment>/`
(`dist/module_api/`, `dist/module_jobs/`, and so on) with a source map, and Oxc
emits the legacy decorators and constructor metadata that `oxc.config.ts` asks
for. There is no separate compile step.

The proof (`test:workers`) runs those four bundles in workerd, with actual
service and queue bindings. It checks concurrent identities, unavailable/invalid
credentials, forged caller props, membership/permission/resource denial, and
reads the jobs bundle's source map to check that
background code excludes the HTTP feature modules. The exact same proof runs in
an external consumer of the packed release archives.

Each worker has its own Wrangler file and reads its bindings from the framework
`ENV` (`inject: [ENV]` or `@InjectEnv()`). `pnpm types` runs `wrangler types
--include-runtime=false` for each Worker, passing the target service configs to infer named method bindings, into
`worker-configuration.<worker>.d.ts`, and `typecheck` checks each worker as its
own program (`tsconfig.<worker>.json`), so a worker's `VelaEnv` only has the
bindings its own Wrangler file declares.

Catalog, accounts, and jobs have no public
route, workers.dev URL, or preview URL. Their RPC modules explicitly allow callers
that possess the service binding; applications needing user/tenant authorization
must also provide that policy. Deployment is explicit and requires configuring
real resources; the proof uses local bindings only. The named native entrypoint
requires verified end-user identity even when the caller holds its binding.
`ENTRYPOINT_PROPS` validates the calling application separately and never supplies
the principal. The HTTP-only application guard demonstrates that native calls
use their explicit scoped guard list and exclude `APP_*`.

Share contracts and domain modules. Give each deployment a root module that
imports only the needed API or background surface. Services do not become remote
merely because a module is imported: use an injected RPC client to cross Workers.
Native workflows are not part of this example.
