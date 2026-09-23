---
"@velajs/vela": minor
---

**Behavior change:** Resolving a request-scoped provider on the root container now throws instead of constructing it there and caching it for the life of the application. This covers providers declared with `Scope.REQUEST` and providers that are request-scoped because they depend on one, through `container.resolve()`, `container.resolveAsync()` and therefore `app.get()`. Resolve them in the execution scope of the invocation: `getRequestContainer(c)`, `context.getContainer()` or the `runInEntrypointScope()` callback argument. Application-level error reporting on the root container falls back to the default report when the registered exception handler is request-scoped.

**Behavior change:** `DiscoveryFilter.includeRequestScoped` is removed. Pass `requestScope`, an execution-scope container of the same application, to resolve request-scoped discovery hits inside that invocation. Without it they are still returned with `instance: undefined`.

Add `InjectionTokenOptions.scope`. `new InjectionToken(name, { scope: Scope.REQUEST, factory })` declares a per-scope value that a runtime seeds with `setRequestInstance()`: its consumers are request-scoped in every container, even before the token is first resolved, and `factory` runs only in a scope that nothing seeded, so it can throw to say where the token resolves. A token default without `scope` is still a singleton.

Adds `Container.getResolvedScope(token, moduleId?)`, the effective scope of what a resolution would return without constructing it, and `Container.sharesRootWith(other)`.
