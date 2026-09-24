---
'@velajs/graphql': minor
---

Build `GraphqlModule` on `defineModule`, adding `forRootAsync`: `path` and `imports` are structural (`GraphqlStructuralOption`) and the factory returns the schema, driver and field pipeline.

**Behavior change:** each path is one module instance, and a path's controller and service token are shared by its registrations. Registering the same path again with different options is reported by the module loader instead of mounting a second endpoint class.
