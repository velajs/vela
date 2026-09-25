---
'@velajs/better-auth': minor
---

The mounted Better Auth handler carries `SkipGuardPhases(['tenant', 'authorize'])` from `@velajs/vela/module-kit`, so the global tenant and authorization guards whose class declares `static readonly skippable = true` (`TenantGuard`, `PermissionGuard`, `RolesGuard` and `CedarGuard`) never block sign-in. Throttling and the other global guards still run there.

**Behavior change:** those guards no longer run on the Better Auth handler, including one the application registers itself, such as `{ provide: APP_GUARD, useClass: TenantGuard }`, and an application guard that extends one without declaring `static override readonly skippable = false`. @velajs/better-auth 1.30.0 ran every global guard on the handler.
