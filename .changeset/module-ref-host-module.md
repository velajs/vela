---
"@velajs/vela": minor
---

**Behavior change:** `ModuleRef` is now scoped to the module that injects it. The container builds one per module and owner: singletons receive one owned by the application root, and request-scoped consumers receive one bound to their own request, which closes with it. `ModuleRef` is no longer registered in the root bucket, so `container.has(ModuleRef)` is `false`, and its constructor takes `(container, moduleId)`. `app.get(ModuleRef)` still returns an application-wide reference.

- `get(token, { strict })` resolves with the host module's visibility (its own providers, its imports' exports and global tokens) instead of looking the token up across the application. Pass `{ strict: false }` for the application-wide lookup. `get` now throws for request-scoped and transient providers.
- `resolve(token, context?, { strict })` now returns a `Promise`. `context` is an `ExecutionContext`, the Hono `Context` of a Vela-managed request, or an execution-scope `Container`, and request-scoped providers resolve in that scope. Without a context it resolves where the reference is owned, so a singleton's reference throws for request-scoped providers instead of caching them on the root. It never creates a request scope.
- `create(Type)` now returns a `Promise` and injects the class's dependencies with the host module's visibility. It no longer bypasses module visibility.

`Container.createDetached()` is removed. Use `moduleRef.create(Type)` or the new `Container.construct(Type, moduleId)`. Adds the `ModuleRefContext` and `ModuleRefLookupOptions` types.
