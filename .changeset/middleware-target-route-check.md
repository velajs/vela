---
"@velajs/vela": minor
---

Check relative `forRoutes()` and `exclude()` path targets against the routes registered at startup, so a target for a route served outside the global prefix no longer matches nothing silently. The check samples concrete paths shaped like each target and route, reading a `{regex}`-constrained route parameter as one segment, so `forRoutes('users/:id')` reaches `users/:id{[0-9a-f-]{36}}` whatever the constraint; it only reports, and never decides whether a request runs the middleware.

**Behavior change:** with a global prefix, a relative target that reaches no route under the prefix but matches a route served outside it, such as `forRoutes('rpc')` for the `RpcModule` endpoint or a route contributor's path, now throws at route build and names the `{ path, absolute: true }` form to use instead.

**Behavior change:** a relative `forRoutes()` target that matches no route registered at startup is reported through the container's diagnostics policy (`'log'` warns, `'throw'` fails bootstrap). Routes added to the Hono app after startup, such as `mountOpenApi()` documents, WebSocket upgrade paths and `app.getHonoApp()` routes, need `{ path, absolute: true }` with the path they are served on. The report suggests the resolved path with the global prefix kept, such as `{ path: '/api/users/:id', absolute: true }`, never one that drops it.
