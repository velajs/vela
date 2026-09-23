# Worker Bindings Lab

Consumer example linked to the shared API workspace. It exercises native typed
Worker environments through the package's public API, with in-memory bindings
for fast Node tests. The main package's Workers suite additionally tests real
KV, D1, R2, and Durable Objects.

This lab is a **Node host**: its tests and smoke script run the Worker-shaped
application in Node against the mocks in `src/mock-env.ts`, never in workerd.

From the workspace root:

```sh
pnpm --dir apps/worker-bindings-lab typecheck
pnpm --dir apps/worker-bindings-lab test
pnpm --dir apps/worker-bindings-lab smoke
```

Vitest and tsdown compile the TypeScript with Oxc, which emits the legacy
decorators and `design:paramtypes` metadata Vela reads (`vitest.config.ts` sets
them; tsdown takes them from `tsconfig.json`). `smoke` builds `src/smoke.ts`
with tsdown into `dist/` and runs it with Node.

The native environment is the framework `ENV`: services and controllers inject
it with `@InjectEnv()`. The lab has no Wrangler file, so `src/env.ts` declares
the bindings on `Cloudflare.Env` the way `wrangler types` would generate them,
and `VelaEnv` picks them up. `createWorkerBindingsLabApp(env)` constructs an
explicit application for tests; the Worker entry uses `createCloudflareWorker`
for lazy per-environment bootstrap.

The example covers KV, D1, R2, typed queues, Durable Objects, AI, Vectorize,
Hyperdrive, the injected environment, scheduled triggers, Vela cron handlers,
and queue consumers. Native bindings are injected directly; no binding wrapper
modules or services are required.
