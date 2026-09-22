---
'@velajs/vela': minor
'@velajs/authz': patch
'@velajs/mail': patch
---

Module-level `@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters` and `@UseMiddleware` now run once per request when the same module classes are bootstrapped more than once in an isolate (per-environment rebuilds, Durable Object instances, tests). Previously every bootstrap added another copy to the module's controllers, so later applications wrapped responses twice and ran guards such as throttling twice.

**Behavior change:** module-level components are resolved per application from the module instance that declares the controller instead of being copied onto the controller's metadata. `MetadataRegistry.propagateControllerComponents()` is removed, and `MetadataRegistry.getController()` returns only a class's own decorations. Use the new `getScopedComponents(type, class, method, container, moduleId)` to read the declared entries, module-level ones included, without constructing them; `resolveScopedComponents()` and `resolveScopedComponentsAsync()` include them for the owning `moduleId` (or the class's only owner when it is omitted). The `@velajs/authz` authorization audit and `@velajs/mail` inbound dispatch recognize module-level components the same way.
