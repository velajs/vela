---
"@velajs/vela": minor
---

**Behavior change:** importing the same `(class, key)` module instance twice with different inputs is now reported through the container's diagnostics policy (`'log'` warns, `'throw'` fails bootstrap) instead of silently dropping the repeat's providers. `defineModule`, `sideEffectModule` and `defineConfigurableModule` record the inputs each definition was built from. The loader compares plain values structurally and functions or class instances by reference, using ids owned by that loader, so two closures with the same source are different inputs. The first definition still wins, and identical repeats still deduplicate without a diagnostic.
