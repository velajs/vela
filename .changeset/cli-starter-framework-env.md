---
'@velajs/cli': minor
---

**Behavior change:** `vela new` generates a Worker entry that is only `export default createCloudflareWorker(AppModule)`, with no hand-written environment `InjectionToken`: providers read bindings, variables and secrets through the framework `ENV` (`@InjectEnv()` or `inject: [ENV]`). Generated projects add a `types` script, `wrangler types --include-runtime=false`, which also runs before `dev`, and commit its `worker-configuration.d.ts` so `VelaEnv` carries the bindings declared in `wrangler.jsonc`. They pin `@velajs/vela` and `@velajs/cloudflare` releases that provide `ENV`.
