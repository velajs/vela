---
"@velajs/vela": minor
---

Add a framework-owned runtime environment. `ENV` is a global `InjectionToken<VelaEnv>` with no default, `InjectEnv()` injects it (`constructor(@InjectEnv() env: VelaEnv)`), and `VelaEnv` is an empty interface that runtime packages augment through declaration merging. A runtime seeds ENV once per application: `VelaFactory.create(root, { env })` and `bootstrap(root, { env })` accept the environment object (a Node host may pass `process.env` from its own entrypoint), and a `RuntimeAdapter` can register it in `configureContainer`. A non-object `env` is rejected at bootstrap.

**Behavior change:** `CONFIG_ENV` is removed, with no alias. Seed the environment through `ENV` instead (the `env` option, a runtime adapter, or `@velajs/cloudflare`). `UrlGeneratorService`, `SignedUrlGuard`, `InternalDispatcher` and `SignedInvocationGuard` now read a string `URL_SIGNING_SECRET` from ENV when no explicit secret or `URL_SIGNING_SECRET` provider is set. ENV carries bindings and secrets, so a `URL_SIGNING_SECRET` variable or secret in the runtime environment now takes effect automatically, including on Workers, where `CONFIG_ENV` was never provided. Non-string values are ignored. Values in ENV come from outside the program: validate each value your own code reads before assigning a domain type.

**Behavior change:** the root barrel no longer re-exports Hono's `env` and `getRuntimeKey` adapter helpers, which were easy to confuse with `ENV`. Import them from `hono/adapter` directly if you still need them.
