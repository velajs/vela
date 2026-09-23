---
"@velajs/cloudflare": minor
---

The Cloudflare runtime seeds the native environment as the framework `ENV`, in the Worker and in every `VelaWebSocketDurableObject`, and types it with the environment `wrangler types` generates: the package augments `VelaEnv` with `Cloudflare.Env`, so `@InjectEnv() env: VelaEnv`, `inject: [ENV]` factories and `registerAs` factories see your bindings, variables and secrets typed. Run `wrangler types` (for example with `--include-runtime=false` alongside `@cloudflare/workers-types`) so `Cloudflare.Env` declares them. The per-environment application cache and the environment identity assertion are unchanged.

`createCloudflareWorker` and `createCloudflareApp` accept `adapters: RuntimeAdapter[]`, composed after the Cloudflare adapter for each application, so a Worker entry can stay `export default createCloudflareWorker(AppModule, { adapters: [...] })` without a hand-written per-environment cache.

**Behavior change:** the `envToken` option is removed from `createCloudflareWorker`, `createCloudflareApp`, `cloudflareAdapter`, `VelaWebSocketDurableObject` and `buildDoRuntime`, with no alias. Delete the application's environment `InjectionToken` and inject `ENV` from `@velajs/vela` instead: `createCloudflareWorker(AppModule)`, `VelaWebSocketDurableObject(AppModule)`, `cloudflareAdapter({ env })`. `CloudflareApplication` and `CloudflareRoot` are no longer generic; their environment type is `VelaEnv`.

**Behavior change:** the `@Env()` parameter decorator is removed. Inject the environment with `@InjectEnv()` in a constructor, or read a binding in a factory with `inject: [ENV]`.

**Behavior change:** ENV now carries every binding, variable and secret of the Worker, so framework readers pick up values such as `URL_SIGNING_SECRET` (URL and invocation signing) and `VELA_STUDIO_TOKEN` (Studio) automatically once they are set as variables or secrets. Values come from outside the program: validate each value your code reads before relying on it.
