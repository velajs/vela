---
"@velajs/vela": minor
---

Translate Nest's wildcard middleware targets to Hono patterns: `forRoutes()` and `exclude()` accept `cats/*path` (Nest 11), `cats/{*splat}` and `cats/(.*)`, which all match like Hono's `cats/*` (including `/cats` itself). They previously never matched, so the middleware silently skipped the routes they named.

**Behavior change:** a `forRoutes()` or `exclude()` path that uses other group, optional-segment or named-wildcard syntax, such as `:id(\d+)`, `users{/:id}` or `ab*cd`, now throws at route build instead of silently matching nothing. Hono's regex-constrained parameters such as `:id{[0-9]+}` are still accepted; use them for a constrained segment.
