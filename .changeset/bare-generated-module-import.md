---
'@velajs/vela': patch
---

A bare import of a generated module class that has no `@Module()` of its own, such as `imports: [CedarModule]` instead of `CedarModule.forRoot({ ... })`, now always fails bootstrap with `CedarModule is not a module: import CedarModule.forRoot(...) or CedarModule.forRootAsync(...) instead of the bare class, which configures nothing` (`register(...)`/`registerAsync(...)` for a `ConfigurableModuleBuilder` class). Previously, once any configured definition of the class had loaded in the process, in the same application or an earlier bootstrap, a bare import booted silently with none of the module's providers and without the global guard it installs. A generated class that declares `@Module()` itself is still imported bare, as before.
