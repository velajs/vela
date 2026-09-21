# Dependency injection ownership

Declare dependencies with constructor injection or `defineProvider(token, { inject, useFactory })`.
Factory parameters are inferred from their tokens; the result must satisfy the provided token.
An `InjectionToken<T>` represents an identity, so two tokens with the same description remain distinct.

Each module owns its provider registrations. A token registered in two module instances has two
independent instances, including with `Scope.REQUEST`. Within a request child, repeated resolutions
of the same registration share a value; resolutions from another module's registration remain separate.
Concurrent `resolveAsync` calls share construction only for the same singleton or request registration.
Provider replacement creates a new registration and does not reuse the previous request value.

`setRequestInstance(token, value)` explicitly seeds a value in one container. It overrides constructed
request values for that token, including an intentional `undefined`. The seed still requires a visible
request-scoped registration and cannot expose a private provider or create a missing provider.
Framework integrations register a globally visible request provider at bootstrap and seed it in each
request child. Seeds and `useValue` objects belong to their caller.

For diagnostics and discovery, `getProviderScope(token, moduleId)`, `isLazyPending(token, moduleId)`
and `isInstantiated(token, moduleId)` inspect that exact declaring module without constructing a
provider. They do not follow imports or global fallback. Omitting `moduleId` retains their token-wide
behavior. Resolve using `resolve(token, moduleId)` or `resolveAsync(token, moduleId)` to apply the
requesting module's visibility rules.

Circular dependencies through `useExisting` produce a circular-dependency error on both synchronous
and asynchronous resolution. Separate registrations sharing a token do not constitute a cycle.
