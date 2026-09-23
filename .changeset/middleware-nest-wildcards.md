---
"@velajs/vela": minor
---

Accept Nest's trailing wildcards in `forRoutes()` and `exclude()` targets. A trailing `cats/{*splat}`, like `cats/*`, matches `/cats` and every path beneath it, as in Nest. A trailing `cats/*path` or `cats/(.*)` matches one or more characters beneath `/cats` but not `/cats` itself, so `exclude('users/*id')` still runs the middleware on `/users`. `'*'`, `'/*'` and `'{*splat}'` match every request.

**Behavior change:** path targets accept only literal segments, `:name` segments and a trailing wildcard. Other syntax now throws at route build, naming its cause, instead of matching whatever one of Hono's routers makes of it: `{regex}` constraints such as `:id{[0-9]+}` or `:action{login|register}` (Hono's TrieRouter anchors only the first and last alternative of a top-level `|`, so the latter also matched `/auth/login-as/42`, and constraints that span segments backtracked), optional `?` segments such as `:id?`, a wildcard before the last segment such as `files/*/raw`, `*/*` or `files/*path/:id`, a `*` or `:` inside a segment such as `us*` or `abc:name`, other parentheses or braces such as `:id(\d+)` or `users{/:id}`, and empty segments such as `a//b`. Use `:name`, list each path, or target the controller.
