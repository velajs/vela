---
"@velajs/vela": minor
---

**Behavior change:** importing the same `(class, key)` module instance twice with different inputs is now reported through the container's diagnostics policy (`'log'` warns, `'throw'` fails bootstrap) instead of silently dropping the repeat's providers. `defineModule`, `sideEffectModule` and `defineConfigurableModule` record the inputs each definition was built from. The loader compares plain values structurally and functions by source text, so a shared helper that rebuilds the same `forRootAsync` config is one input; classes, native or bound functions and class instances such as tokens compare by reference, using ids owned by that loader. The diagnostic suggests importing one shared definition, or giving each configuration its own `key`. The first definition still wins, and identical repeats still deduplicate without a diagnostic.
