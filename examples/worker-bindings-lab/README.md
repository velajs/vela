# Worker Bindings Lab

Fake consumer project for `@velajs/cloudflare` installed through `file:../..` and `@velajs/vela` installed through `file:../../../vela`.

It simulates a Cloudflare Worker with mocked bindings rather than calling package internals directly.

```sh
pnpm --dir examples/worker-bindings-lab install
pnpm --dir examples/worker-bindings-lab typecheck
pnpm --dir examples/worker-bindings-lab test
pnpm --dir examples/worker-bindings-lab smoke
```

Covered behaviors:

- `createCloudflareApp()` and `CloudflareApplication`.
- Worker-shaped `fetch`, `scheduled`, and `queue` handlers.
- `KVModule`, `D1Module`, `R2Module`, `QueueModule`, `DurableObjectModule`, `AIModule`, `VectorizeModule`, and `HyperdriveModule`.
- All corresponding service wrappers.
- `@Env`, `@Scheduled`, `@QueueConsumer`, and Vela `@Cron` handling in a Worker runtime shape.
