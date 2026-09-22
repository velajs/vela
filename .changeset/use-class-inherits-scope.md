---
"@velajs/vela": minor
---

**Behavior change:** A `useClass` provider now keeps the scope its class declares with `@Injectable({ scope })` unless the provider sets `scope` itself. Request-scoped classes registered through `defineProvider(token, { useClass })`, an `APP_*` `{ useClass }` provider, `ErrorsModule.forRoot({ handler })` or `app.useGlobalExceptionHandler(Class)` now get a fresh instance per request instead of one singleton shared across requests. Set `scope` on the provider to choose a different lifetime explicitly.
