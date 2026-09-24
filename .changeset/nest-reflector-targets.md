---
'@velajs/vela': minor
'@velajs/graphql': minor
'@velajs/studio': patch
---

The `Reflector` accepts Nest's targets as well as an execution context: `reflector.get(key, context.getHandler())`, `reflector.get(key, context.getClass())` and `getAll`/`getAllAndOverride`/`getAllAndMerge(key, [context.getHandler(), context.getClass()])`. `SetMetadata` records each decorated method, so a handler function reads its method's metadata. `Reflector.createDecorator({ key?, transform? })` stores `transform(value)`, and readers are typed with the transformed value.

**Behavior change:** `ExecutionContext.getHandler()` returns the handler method, as in Nest, instead of its name. The new `getHandlerName()` returns the name (or a framework host's marker symbol). Custom execution contexts implement both; code that used the handler name, such as a cache or throttling key, calls `getHandlerName()`. GraphQL field contexts report the resolver method.
