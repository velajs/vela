---
"@velajs/vela": minor
---

Translate Nest's wildcard middleware targets to Hono patterns with Nest's meaning: `forRoutes()` and `exclude()` accept `cats/*path` (Nest 11) and `cats/(.*)`, which become `cats/:path{.+}` and match one or more segments below `/cats` but not `/cats` itself, so `exclude('users/*id')` still runs the middleware on `/users`. A mid-path wildcard such as `files/*path/download` matches one or more segments in its place. A trailing `cats/{*splat}` becomes Hono's `cats/*`, which also matches `/cats`, as in Nest. These targets previously never matched, so the middleware silently skipped the routes they named.

**Behavior change:** a `forRoutes()` or `exclude()` path that uses other group, optional-segment or named-wildcard syntax, such as `:id(\d+)`, `users{/:id}`, `ab*cd` or a `{*splat}` before the last segment, now throws at route build instead of silently matching nothing. Hono's regex-constrained parameters such as `:id{[0-9]+}` are still accepted; use them for a constrained segment.
