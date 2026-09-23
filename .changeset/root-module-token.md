---
"@velajs/vela": minor
---

`VelaFactory.create`, `bootstrap` and `ModuleLoader.load` accept a `DynamicModule` root as well as a module class, so a configurable root such as `AppModule.forRoot(...)` needs no wrapper class. `createOpenApiDocument` documents a `DynamicModule` root too.

`bootstrap` registers the root, exactly as passed, as the new global `ROOT_MODULE` token next to `Container`, so any module can read the application's graph (for example to document it) without importing the root back.

`countRegisteredClasses()` in `@velajs/vela/internal` reports how many classes the isolate-global metadata registry holds, for tests that prove a bootstrap path declares nothing new.
