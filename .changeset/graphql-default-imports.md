---
'@velajs/graphql': patch
---

`GraphqlModule` declares `imports: []` as a structural default, so `GraphqlModule.forRoot(options)` and `forRoot({ ...options, imports: [] })` are one configuration and mount one endpoint instead of failing bootstrap as different options. Another `imports` list on the same path still fails bootstrap.
