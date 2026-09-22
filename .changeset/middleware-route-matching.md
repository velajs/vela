---
"@velajs/vela": minor
---

Fix consumer middleware that silently skipped the routes it was bound to. `forRoutes(Controller)` now runs on each of the controller's routes, with their HTTP methods, under the global prefix and URI version. It also covers an empty-path `@Controller()`, and HEAD requests served by a GET handler. Path targets match Hono route patterns such as `users/:id`, and middleware still matches when a parent app mounts the Vela app with `parent.route(base, app)`.

**Behavior change:** String and `{ path, method }` targets in `forRoutes()` and `exclude()` now resolve under the global prefix, so write them without it. A startup warning flags targets that still include the prefix. `exclude()` matches its patterns exactly and no longer skips the paths nested beneath them. `forRoutes(Controller)` matches only that controller's own routes and methods, not every path under its prefix, and throws at startup when the controller declares no routes. `forRoutes('*')` is unchanged.
