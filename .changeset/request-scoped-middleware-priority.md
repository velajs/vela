---
"@velajs/vela": minor
---

Global middleware reads a `static priority` from the `useClass` or `useExisting` target of an `APP_MIDDLEWARE` provider without constructing it, so a request-scoped middleware is ordered by its static priority instead of silently sorting at 0.

**Behavior change:** a request-scoped global middleware that declares no `static priority` is reported through the container's diagnostics policy (`'log'` warns, `'throw'` fails bootstrap), because its position cannot be read at route build and it sorts at priority 0. Declare `static priority` on its class. A singleton `APP_MIDDLEWARE` whose class declares a static priority is no longer constructed at route build to read it.
