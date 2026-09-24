---
'@velajs/vela': minor
'@velajs/graphql': minor
'@velajs/studio': patch
---

The `Reflector` accepts Nest's targets as well as an execution context: `reflector.get(key, context.getHandler())`, `reflector.get(key, context.getClass())` and `getAll`/`getAllAndOverride`/`getAllAndMerge(key, [context.getHandler(), context.getClass()])`. `SetMetadata` records each decorated method, so a handler function reads its method's metadata. A function several controllers decorate (one inherited method decorated per controller) cannot name its controller, so reading through it throws and points to the execution-context form. In the list form, a handler's metadata counts only when a listed class is, or extends, the class that declared it, so metadata one controller puts on a method it inherits never applies to a sibling controller sharing the method. `Reflector.createDecorator({ key?, transform? })` stores `transform(value)`, and readers are typed with the transformed value.

**Behavior change:** `ExecutionContext.getHandler()` returns the handler method, as in Nest, instead of its name. The new `getHandlerName()` returns the name (or a framework host's marker symbol). Custom execution contexts implement both; code that used the handler name, such as a cache or throttling key, calls `getHandlerName()`. GraphQL field contexts report the resolver method.
