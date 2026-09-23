---
"@velajs/vela": minor
"@velajs/studio-protocol": minor
"@velajs/studio": minor
"@velajs/studio-ui": minor
---

Name the default provider lifetime `Scope.DEFAULT`, as Nest does.

**Behavior change:** Scope.SINGLETON is renamed Scope.DEFAULT (Nest naming); no alias. Replace every `Scope.SINGLETON` with `Scope.DEFAULT`. The member's runtime value changes from `'singleton'` to `'default'`, so `getScope`, `Container.getProviderScope`, `Container.getResolvedScope`, `DiscoveryService` registrations and the conflicting-scope decorator error now report `default`. Code that compares a scope against the string `'singleton'` must compare against `Scope.DEFAULT` instead.

**Behavior change:** Studio's `app.modules` provider scopes and `app.entrypoints` scopes label that lifetime `default` instead of `singleton`. `StudioProviderScope` is now `'default' | 'transient' | 'request'`, and the response validators reject `singleton`. The envelope and `STUDIO_PROTOCOL_VERSION` (2) are unchanged, so upgrade `@velajs/vela`, `@velajs/studio` and `@velajs/studio-ui` together; an older Studio UI rejects these responses from an upgraded application.
