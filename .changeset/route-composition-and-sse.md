---
'@velajs/vela': minor
'@velajs/cloudflare': minor
'@velajs/cli': patch
'@velajs/studio': patch
---

Routes compose like Nest's `setGlobalPrefix(prefix, { exclude })` and URI versioning:

- `VelaFactory.create(AppModule, { globalPrefix: '/api', globalPrefixOptions: { exclude: ['health', { path: 'webhooks/:id', method: 'POST' }] } })` serves matching controller routes without the prefix. Targets use the middleware route grammar and match the controller path plus the route path. A relative middleware target resolves under the prefix, so startup fails when one also matches an excluded route that no absolute or controller target of the same middleware covers or excludes. `RouteManager.setGlobalPrefix(prefix, { exclude })` takes the same options, and `createCloudflareWorker`/`createCloudflareApp` pass them through.
- `VERSION_NEUTRAL` serves a controller or route without a version segment; combine it with numbers (`@Version([2, VERSION_NEUTRAL])`) to serve both.
- `versioning: { prefix }` sets the text before the version number (default `'v'`; `false` serves `/1/...`).
- `app.getRoutePathOptions()` returns this composition; pass it to `createOpenApiDocument(AppModule, app.getRoutePathOptions())` so documents match the served paths. The CLI's OpenAPI and client commands and Studio's OpenAPI view use it, and route contributors receive it as `routePathOptions`.

**Behavior change:** With a global prefix, startup fails for any relative `forRoutes()` target that reaches prefixed routes while its written path also matches a route registered outside the prefix, not only a route `exclude` serves unprefixed. An adapter's absolute route counts too: under `globalPrefix: '/api'`, `forRoutes(':resource')` also matches the `RpcModule` endpoint `POST /rpc`, so startup fails. Previously the build failed only when such a target reached no prefixed route at all. Cover the outside route in the same `forRoutes()` with an absolute target (`{ path: '/rpc', absolute: true }`) or its controller, or leave it out with an absolute `exclude()`.

`@Sse()` handlers can return an async iterable (such as an `async *` generator) of `MessageEvent` (`{ data, id?, type?, retry? }`). Each event is streamed with Hono's `streamSSE` as it is produced, the iterable is closed when the client disconnects, and a failure mid-stream is reported without sending its message. A returned `Response` is still sent as is. `@Sse` no longer loads in a Worker that does not use it.

**Behavior change:** `@Sse()` is no longer a plain GET route that sends its handler's result like any other route: the handler must return an iterable or async iterable of `MessageEvent`, or a `Response` (`SseResult`). Another return type no longer compiles, and a handler that returns anything else, such as a JSON object, fails the request with a reported, redacted 500. Yield `MessageEvent`s, or keep returning the `Response` of Hono's `streamSSE(c, ...)`.
