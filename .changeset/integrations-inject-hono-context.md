---
'@velajs/storage': patch
'@velajs/graphql': patch
---

The storage HTTP controller and the GraphQL endpoint inject the Hono context with `@Ctx()`, because `@Req()` injects the platform `Request` from @velajs/vela 1.31.0.
