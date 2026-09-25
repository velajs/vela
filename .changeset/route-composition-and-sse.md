---
'@velajs/vela': minor
'@velajs/cloudflare': minor
---

Routes compose like Nest's `setGlobalPrefix(prefix, { exclude })` and URI versioning:

- `VelaFactory.create(AppModule, { globalPrefix: '/api', globalPrefixOptions: { exclude: ['health', { path: 'webhooks/:id', method: 'POST' }] } })` serves matching controller routes without the prefix. Targets use the middleware route grammar and match the controller path plus the route path. A relative middleware target resolves under the prefix, so startup fails when one also matches an excluded route that no absolute or controller target of the same middleware covers or excludes. `RouteManager.setGlobalPrefix(prefix, { exclude })` takes the same options, and `createCloudflareWorker`/`createCloudflareApp` pass them through.
- `VERSION_NEUTRAL` serves a controller or route without a version segment; combine it with numbers (`@Version([2, VERSION_NEUTRAL])`) to serve both.
- `versioning: { prefix }` sets the text before the version number (default `'v'`; `false` serves `/1/...`).
- `app.getRoutePathOptions()` returns this composition; pass it to `createOpenApiDocument(AppModule, app.getRoutePathOptions())` so documents match the served paths. The CLI's OpenAPI and client commands and Studio's OpenAPI view use it, and route contributors receive it as `routePathOptions`.

**Behavior change:** With a global prefix, startup fails for any relative `forRoutes()` target that reaches prefixed routes while its written path also matches a route registered outside the prefix, not only a route `exclude` serves unprefixed. An adapter's absolute route counts too: under `globalPrefix: '/api'`, `forRoutes(':resource')` also matches the `RpcModule` endpoint `POST /rpc`, so startup fails. Previously the build failed only when such a target reached no prefixed route at all. Cover the outside route in the same `forRoutes()` with an absolute target (`{ path: '/rpc', absolute: true }`) or its controller, or leave it out with an absolute `exclude()`. An absolute target or exclude accounts only for the outside routes it matches itself: with both `RpcModule` and an excluded `health` route, `forRoutes(':resource', { path: '/rpc', absolute: true })` still fails startup for `GET /health` until that route is covered or excluded too.
