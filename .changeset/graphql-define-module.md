---
'@velajs/graphql': minor
---

Build `GraphqlModule` on `defineModule`, adding `forRootAsync`: `path` and `imports` are structural (`GraphqlStructuralOption`) and the factory returns the schema, driver and field pipeline.

**Behavior change:** each path is one module instance, and a path's controller and service token are shared by its registrations. Registering the same path again with different options fails bootstrap instead of mounting a second endpoint class.

`path` defaults to `/graphql` and `imports` to `[]` as structural defaults, so `forRoot(options)`, `forRoot({ ...options, path: '/graphql' })` and `forRoot({ ...options, imports: [] })` are one configuration and mount one endpoint. Another `imports` list on the same path fails bootstrap.
