---
"@velajs/cloudflare": minor
---

**Behavior change:** Workers and Durable Objects are built from static roots only. `createCloudflareWorker`, `createCloudflareApp` and `VelaWebSocketDurableObject` take a module class or a `DynamicModule` declared at module scope; `CloudflareRoot` is now `Type | DynamicModule`. The `{ create(env) }` and async `{ create: async (env) => ... }` roots are removed, with no alias, together with the per-(root, environment) resolution cache. Read bindings where each application is built instead: `Module.forRootAsync({ inject: [ENV], useFactory: (env) => ({ ... }) })`, `useFactory` providers that inject `ENV`, or `@InjectEnv()` constructors. These run for each application, so nothing built from one environment is shared with another, and constructing another application or Durable Object instance declares no new classes in the isolate. The per-environment application cache of `createCloudflareWorker` is unchanged.

WebSocket upgrade routes authenticate with the gateway's `authenticator`, resolved once per application from the module that declares the gateway, and read an `(env) => origins` allowlist from the Worker's `ENV`. Authentication still completes before the Durable Object id is derived, and client-supplied `x-vela-*` headers are still stripped first. `UpgradeAuthenticator`, `WebSocketUpgradeIdentity` and `WebSocketUpgradeAuthenticationContext` are re-exported from the package root.

**Behavior change:** `registerWebSocketRoutes(hono, routes, container)` and `collectWsGatewayRoutes(instance, container)` take the application's container, and `WsGatewayRoute` carries the declaring `moduleId`.
