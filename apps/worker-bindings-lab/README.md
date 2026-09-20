# Worker Bindings Lab

Consumer example linked to the shared API workspace. It exercises native typed
Worker environments through the package's public API, with in-memory bindings
for fast Node tests. The main package's Workers suite additionally tests real
KV, D1, R2, and Durable Objects.

From the workspace root:

```sh
pnpm --dir cloudflare/examples/worker-bindings-lab typecheck
pnpm --dir cloudflare/examples/worker-bindings-lab test
pnpm --dir cloudflare/examples/worker-bindings-lab smoke
```

`WORKER_ENV` carries the environment type into DI. `createWorkerBindingsLabApp(env)`
constructs an explicit application for tests; the Worker entry uses
`createCloudflareWorker` for lazy per-environment bootstrap.

The example covers KV, D1, R2, typed queues, Durable Objects, AI, Vectorize,
Hyperdrive, HTTP environment parameters, scheduled triggers, Vela cron handlers,
and queue consumers. Native bindings are injected directly; no binding wrapper
modules or services are required.
