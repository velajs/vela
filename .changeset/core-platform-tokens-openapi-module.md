---
'@velajs/vela': minor
---

Runtime adapters wire platforms into `WebSocketModule` and `LiveModule` through two optional global tokens, so the modules themselves stay the same on every runtime:

- `WS_TRANSPORT` (`@velajs/vela/websocket`) holds a `WebSocketTransport`. Its `createServer(driver)` builds the server gateways inject; without one, the server broadcasts through the module's sync driver as before. A transport whose sockets live in another isolate implements `forwardUpgrade(upgrade)` and names its `forwardingHeaders`: `WebSocketModule` then mounts an upgrade route for each gateway that names a `binding`. The route removes client copies of those headers, resolves the room, runs the gateway's origin, authorization and authenticator checks, reconciles the result with the request's trusted identity (the earlier expiry wins; a conflict answers 403), and passes a `ForwardedWebSocketUpgrade` to the transport. The server and the upgrade routes read one transport, so an application's `@Global()` module that provides and exports `WS_TRANSPORT` overrides the adapter's for both.
- `LIVE_PLATFORM` (`@velajs/vela/live`) holds a `LivePlatform`. `LiveModule` uses `options.driver?.() ?? platform.liveDriver() ?? localLive()` and `options.log?.() ?? platform.cursorLog?.() ?? new InMemoryCursorLog()`, then hands the driver in effect to `platform.bindDriver?.(driver)`.

`WebSocketModule.forRoot()` and `LiveModule.forRoot()` accept no argument when every option keeps its default.

Add `OpenApiModule` to `@velajs/vela/openapi`. `OpenApiModule.forRoot({ path, info })` serves the application's OpenAPI 3.1 document at `path` (default `/openapi.json`, mounted as given), with no controller to write. The document covers the application root (`ROOT_MODULE`), including contributed routes, under the application's global prefix. It does not read the application's `globalPrefixOptions` or `versioning`: an application that sets either passes the same values to `OpenApiModule.forRoot()` (or returns them from the `forRootAsync` factory); otherwise the document lists excluded routes under the prefix and versioned routes with the default `v` version prefix. It is built on the first request and kept for that application, and it leaves its own route out. The route runs no guards. `forRoot` also accepts `tags`, `servers`, `securitySchemes` and `security`, and `forRootAsync` resolves them through dependency injection.

Add `@ApiExclude()` for a controller or a handler: the routes are still served, but the document and generated clients leave them out. `isApiExcluded(target, handler?)` reads it.
