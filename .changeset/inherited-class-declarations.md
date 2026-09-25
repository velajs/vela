---
'@velajs/vela': minor
'@velajs/better-auth': minor
'@velajs/authz': minor
'@velajs/authz-cedar': minor
'@velajs/tenant': minor
'@velajs/feature-flags': minor
---

Declarations on an ancestor class apply to the classes that extend it, as reflect-metadata resolves them in Nest. In @velajs/vela 1.30.0 every reader looked only at the concrete class. Route decorators (`@Get()`, `@Post()`, …) are still read from the controller class itself, unlike Nest: a method an ancestor routes is not mounted on the subclass. Route an inherited method on the subclass, for example `Get('list')(Sub.prototype, 'list', descriptor)`.

- Class metadata applies to a subclass through every `Reflector` form (`get`, `getClass`, `getAll`, `getAllAndOverride` and `getAllAndMerge`, with an execution context, `context.getClass()` or the `[context.getHandler(), context.getClass()]` list): the controller's own, else the nearest ancestor's, so `@Roles(['admin'])` on an abstract base controller guards every controller that extends it.
- Method metadata an ancestor declares on a method the controller inherits without overriding, such as one it routes with `Get()(Sub.prototype, 'list', descriptor)`, applies through every `Reflector` form too: the nearest declaration wins, the controller's own, else the nearest ancestor's. A method the controller overrides reads only its own declarations, and metadata one controller declares on a shared method never applies to a sibling.
- Class-level `@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters` and `@UseMiddleware` on an ancestor run for the subclass on every transport, the root class's first and the subclass's own last. On an inherited method, the method-level enhancers each ancestor declares run before the controller's own, and `@Serialize` and `SkipGuardPhases` read the nearest declaration. The module loader registers the enhancer classes a class inherits, as it does its own.
- Guards that read route metadata, such as `AuthGuard`, `RolesGuard`, `PermissionGuard`, `TenantGuard`, `CedarGuard`, `FeatureFlagGuard` and `ThrottlerGuard`, enforce inherited requirements, and `authorizationAudit()` and `auditCedarRoutes()` read declarations as the guards do. `CacheModule` checks `@CacheResponse` at bootstrap as `CacheInterceptor` reads it, and `ThrottlerModule` checks `@Throttle()` as `ThrottlerGuard` reads it, inherited declarations included, so an invalid inherited declaration, such as tags without an invalidation store or a throttler the module does not declare, fails bootstrap instead of every request.

**Behavior change:** class metadata and class-level enhancers an ancestor declares, and the metadata, method-level enhancers, `@Serialize` and `SkipGuardPhases` an ancestor declares on a method a controller inherits unchanged, now apply to the classes that extend it. Requirements such as `@Roles()`, `@RequirePermission()` or `@RequireResource()` there are enforced, where the routes previously ran without them. Opening markers apply the same way: an inherited `@Public()`, `@OptionalAuth()`, `@TenantIgnored()`, `@CedarPublic()`, `@SkipThrottle()` or `SkipGuardPhases` now opens or relaxes routes that previously required authentication, tenant admission, Cedar authorization or throttling. Remove a declaration from the ancestor, or override the method in the controller, where a subclass must not inherit it.
