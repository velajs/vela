---
'@velajs/authz': minor
'@velajs/authz-cedar': minor
'@velajs/better-auth': minor
'@velajs/feature-flags': minor
'@velajs/tenant': minor
---

The built-in guards inject the application `Reflector` instead of constructing their own: `AuthGuard` (`@velajs/better-auth`), `FeatureFlagGuard` (`@velajs/feature-flags`), `PermissionGuard` and `RolesGuard` (`@velajs/authz/vela`), `TenantGuard` (`@velajs/tenant/vela`) and `CedarGuard` (`@velajs/authz-cedar/vela`). `PermissionGuard`, `RolesGuard` and `TenantGuard` are now injectable, so `@UseGuards()` builds them in the declaring module through DI, like any provider.

**Behavior change:** each guard takes the `Reflector` as a constructor parameter, after any dependencies it already had: `new PermissionGuard(reflector)`, `new RolesGuard(reflector)`, `new TenantGuard(reflector)`, `new CedarGuard(reflector)`, `new AuthGuard(auth, options, reflector)` and `new FeatureFlagGuard(flags, reflector)`. Code that constructs a guard itself, such as `app.useGlobalGuards(new TenantGuard(app.get(Reflector)))` or a unit test, passes the application's `Reflector` or a `new Reflector()`, and a subclass that declares its own constructor passes it to `super()`. A guard class passed to `app.useGlobalGuards()` is not built through DI, so pass an instance or register it as `{ provide: APP_GUARD, useClass: PermissionGuard }`. Guards resolved through DI need no change.
