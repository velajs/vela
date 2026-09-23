---
"@velajs/vela": minor
---

**Behavior change:** `@Optional()` now decides by module visibility. It still injects `undefined` when no module registers the token. When another module registers the token without exporting it to the consumer, the mistake is reported through the container's `diagnostics` policy: `throw` fails construction with `ModuleVisibilityError`, `log` warns once per consuming module and injects `undefined`, and `silent` injects `undefined`. Previously such a dependency threw `ModuleVisibilityError` in every mode. An `@Optional()` `InjectionToken` with a default `factory` now receives the factory's value instead of `undefined`.
