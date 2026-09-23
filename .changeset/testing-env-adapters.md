---
"@velajs/testing": minor
---

`Test.createTestingModule(metadata, { env, adapters })` seeds the application's `ENV` and binds runtime adapters through the same bootstrap path as `VelaFactory.create`: adapter `configureContainer`, request middleware, client-IP resolver and lifecycle hooks all apply. `overrideProvider(ENV).useValue(...)` replaces the environment for every module, with or without a seeded `env`. The `TestingModuleOptions` type is exported.
