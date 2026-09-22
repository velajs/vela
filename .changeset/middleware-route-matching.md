---
"@velajs/vela": minor
---

Fix consumer middleware that silently skipped the routes it was bound to. `forRoutes(Controller)` now runs on each of the controller's routes, with their HTTP methods, under the global prefix and URI version. It also covers an empty-path `@Controller()`, and HEAD requests served by a GET handler. Path targets match Hono route patterns such as `users/:id`, and middleware still matches when a parent app mounts the Vela app with `parent.route(base, app)`. Add `RouteInfo.absolute`: `{ path, method?, absolute: true }` matches the path as written, for routes served outside the global prefix such as `mountOpenApi()` documents, the `RpcModule` endpoint, Cloudflare WebSocket upgrades and routes added to the Hono app directly.

**Behavior change:** String and `{ path, method }` targets in `forRoutes()` and `exclude()` now resolve under the global prefix, so write them without it or pass `absolute: true`. A startup warning flags targets that still include the prefix. `exclude()` matches its patterns exactly and no longer skips the paths nested beneath them. `forRoutes(Controller)` matches only that controller's own routes and methods, not every path under its prefix, and throws at startup when the controller declares no routes. `forRoutes('*')` is unchanged.
