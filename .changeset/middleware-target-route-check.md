---
"@velajs/vela": minor
---

Check relative `forRoutes()` and `exclude()` path targets against the routes registered at startup, so a target for a route served outside the global prefix no longer matches nothing silently. The check samples concrete paths shaped like each target and route; it only reports, and never decides whether a request runs the middleware.

**Behavior change:** with a global prefix, a relative target that reaches no route under the prefix but matches a route served outside it, such as `forRoutes('rpc')` for the `RpcModule` endpoint or a route contributor's path, now throws at route build and names the `{ path, absolute: true }` form to use instead.

**Behavior change:** a relative `forRoutes()` target that matches no route registered at startup is reported through the container's diagnostics policy (`'log'` warns, `'throw'` fails bootstrap). Routes added to the Hono app after startup, such as `mountOpenApi()` documents, WebSocket upgrade paths and `app.getHonoApp()` routes, need `{ path, absolute: true }`.
