---
'@velajs/storage': minor
---

The storage HTTP controller carries `SkipGuardPhases(['tenant', 'authorize'])` from `@velajs/vela/module-kit`, because its `http.authorize` callback decides every action: the global tenant and authorization guards whose class declares `static readonly skippable = true` (`TenantGuard`, `PermissionGuard`, `RolesGuard` and `CedarGuard`) do not run on its routes. Authentication, throttling and the other global guards still run there.

**Behavior change:** those guards no longer run on storage routes, including one the application registers itself, such as `{ provide: APP_GUARD, useClass: TenantGuard }`, and an application guard that extends one without declaring `static override readonly skippable = false`. @velajs/storage 1.30.0 ran every global guard on these routes. Check tenant membership and permissions for storage actions in `http.authorize`, which receives the request (`{ req, ctx, driver }`).
