---
'@velajs/vela': patch
'@velajs/authz': patch
'@velajs/authz-cedar': patch
---

`Reflector` reads through an execution context (`reflector.get(key, context)`, `getHandler`, `getAll`, `getAllAndOverride` and `getAllAndMerge` with `context`) now apply method metadata an ancestor class declares on a method the controller inherits without overriding, as the `[context.getHandler(), context.getClass()]` and handler-function forms already did. The nearest declaration wins: the controller's own, else the nearest ancestor's; a method the controller overrides reads only its own declarations, and metadata one controller declares on a shared method still never applies to a sibling. Guards that read the context form, such as `RolesGuard`, `PermissionGuard`, `TenantGuard`, `CedarGuard`, `FeatureFlagGuard` and `ThrottlerGuard`, previously ignored those inherited requirements and let such routes through; inherited markers such as `@Public()`, `@CedarPublic()` and `@SkipThrottle()` now apply the same way. `authorizationAudit()` and `auditCedarRoutes()` read declarations as the guards do.
