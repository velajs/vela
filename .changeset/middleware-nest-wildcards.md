---
"@velajs/vela": minor
---

Translate Nest's trailing wildcards in `forRoutes()` and `exclude()` targets to Hono patterns, and match every target with Hono's own router. `cats/*path` and `cats/(.*)` become `cats/:path{[\s\S]+}`, which matches one or more characters below `/cats` but not `/cats` itself, so `exclude('users/*id')` still runs the middleware on `/users`. A trailing `cats/{*splat}` becomes Hono's `cats/*`, which also matches `/cats`, as in Nest. Targets otherwise mean what Hono's router makes of their pattern: Hono's `*` before the last segment matches one segment, including an empty one where Hono's TrieRouter routes it, and a `:` inside a literal segment is read as the router in use reads it in a route.

**Behavior change:** a Nest wildcard before the last segment of a target, such as `files/*path/:id`, `users/*id/admin` or `cats/{*splat}/toys`, now throws at route build, because no Hono pattern expresses it. So does other group, optional-segment or named-wildcard syntax, such as `:id(\d+)`, `users{/:id}`, `ab*cd` or a `:id?` before the last segment, and a `{regex}` constraint that is not a valid regular expression or that matches an empty segment, which Hono's default router fails on. Use `:id{[0-9]+}` for a constrained segment.

**Behavior change:** a `{regex}` constraint matches as it does in a route. `users/:id{\d+|me}` also matches `/users/12abc` where Hono's TrieRouter serves it, and a `.` does not match the line terminators Hono decodes into the path; write `[\s\S]`, or a trailing `*`, for a catch-all. `exclude('*/*')` no longer skips single-segment paths, and `forRoutes('files/*/:id?')` also covers `/files`, as Hono's `/files/*` does.
