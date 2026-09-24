---
'@velajs/vela': minor
'@velajs/cloudflare': minor
'@velajs/cli': patch
'@velajs/studio': patch
---

Routes compose like Nest's `setGlobalPrefix(prefix, { exclude })` and URI versioning:

- `VelaFactory.create(AppModule, { globalPrefix: '/api', globalPrefixOptions: { exclude: ['health', { path: 'webhooks/:id', method: 'POST' }] } })` serves matching controller routes without the prefix. Targets use the middleware route grammar and match the controller path plus the route path. `RouteManager.setGlobalPrefix(prefix, { exclude })` takes the same options, and `createCloudflareWorker`/`createCloudflareApp` pass them through.
- `VERSION_NEUTRAL` serves a controller or route without a version segment; combine it with numbers (`@Version([2, VERSION_NEUTRAL])`) to serve both.
- `versioning: { prefix }` sets the text before the version number (default `'v'`; `false` serves `/1/...`).
- `app.getRoutePathOptions()` returns this composition; pass it to `createOpenApiDocument(AppModule, app.getRoutePathOptions())` so documents match the served paths. The CLI's OpenAPI and client commands and Studio's OpenAPI view use it, and route contributors receive it as `routePathOptions`.

`@Sse()` handlers can return an async iterable (such as an `async *` generator) of `MessageEvent` (`{ data, id?, type?, retry? }`). Each event is streamed with Hono's `streamSSE` as it is produced, the iterable is closed when the client disconnects, and a failure mid-stream is reported without sending its message. A returned `Response` is still sent as is. `@Sse` no longer loads in a Worker that does not use it.
