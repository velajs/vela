---
"@velajs/testing": minor
---

`Test.createTestingModule(metadata, { env, adapters })` seeds the application's `ENV` and binds runtime adapters through the same bootstrap path as `VelaFactory.create`: adapter `configureContainer`, request middleware, client-IP resolver and lifecycle hooks all apply. `moduleRef.fetch()` and the HTTP and SSE builders send each request with the seeded `env` as the Hono `c.env` unless `fetch(request, env)` passes one explicitly, so an adapter that binds requests to its environment, such as `cloudflareAdapter({ env })` given the same `env`, accepts them. The WebSocket builder keeps the Node transport's own request bindings. `overrideProvider(ENV).useValue(...)` replaces the environment for every module, with or without a seeded `env`. The `TestingModuleOptions` type is exported.
