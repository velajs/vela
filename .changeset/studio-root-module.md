---
"@velajs/studio": minor
---

**Behavior change:** `app.openapi` and the `openapi` capability document the application's root module by default. Studio reads the core `ROOT_MODULE` token when its options name no `rootModule`, so an application no longer hands its root back to Studio, for example through a `forRootAsync` self-reference. `rootModule` still narrows the document to one module and accepts a `DynamicModule`. `resolveStudioConfig(env, options, applicationRoot?)` takes the application root as an optional third argument.
