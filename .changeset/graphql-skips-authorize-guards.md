---
'@velajs/graphql': minor
---

The GraphQL endpoint carries `SkipGuardPhases(['authorize'])` from `@velajs/vela/module-kit`, because resolvers authorize each field: the global authorization guards whose class declares `static readonly skippable = true` (`PermissionGuard`, `RolesGuard` and `CedarGuard`, including Cedar's default deny) do not run on it. Authentication, tenant admission, throttling and the other global guards still run there.

**Behavior change:** those authorization guards no longer run on the GraphQL endpoint, including one the application registers itself, such as `{ provide: APP_GUARD, useClass: RolesGuard }`, and an application guard that extends one without declaring `static override readonly skippable = false`. @velajs/graphql 1.29.0 ran every global guard on the endpoint. Authorize each field with the resolver's guards.
