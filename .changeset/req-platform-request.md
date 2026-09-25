---
'@velajs/vela': minor
'@velajs/better-auth': minor
'@velajs/crud': minor
---

The new `@Ctx()` parameter decorator injects the Hono context (`VelaContext`); `@Res()` still returns it as the response handle.

**Behavior change:** `@Req()` injects the platform `Request`, as Nest's `@Req()` injects the request object, instead of the Hono context. Replace `@Req() c: Context` with `@Ctx() c: Context`, or with `@Req() request: Request` when the handler only read `c.req.raw`. The Better Auth catch-all handler and generated CRUD handlers are migrated.
