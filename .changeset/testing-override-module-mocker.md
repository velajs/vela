---
'@velajs/testing': minor
---

Add Nest's `overrideModule(Module).useModule(Replacement)` and `useMocker(factory)` to the testing module builder. `overrideModule` loads the replacement (a module class or a `DynamicModule`) wherever the graph imports the module class, any `DynamicModule` of it, or exactly the `DynamicModule` passed, including through `exports: [Module]` re-exports, without modifying module metadata. `useMocker` calls `factory(token)` once for each token a constructor or factory injects that no visible provider satisfies, after the overrides and before anything is constructed, and registers the value in each module that needs it; optional parameters, `ModuleRef`, `InjectionToken` defaults and provided or overridden tokens are left alone. As in Nest, a falsy result supplies nothing: the dependency stays unresolved and `compile()` rejects with `UnresolvedDependencyError`.

`Test.createTestingModule(metadata, options)` accepts every `VelaFactory.create` option (`globalPrefix`, `security`, `middleware`, `diagnostics` besides `env` and `adapters`): `TestingModuleOptions` extends `VelaCreateOptions`.
