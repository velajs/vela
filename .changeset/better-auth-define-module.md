---
'@velajs/better-auth': minor
---

Build `BetterAuthModule` on `defineModule`. `basePath`, `mountHandler` and `globalGuard` are structural (`BetterAuthStructuralOption`), and `auth` may be a function, `auth: () => betterAuth({ ... })`, which runs on the first authentication and is cached.

**Behavior change:** the option that registers `AuthGuard` application-wide is renamed from `isGlobal` to `globalGuard` and still defaults to `true`. `isGlobal` is now the standard extra: it makes `BetterAuthService` and its exports visible to every module, and defaults to `false`.

**Behavior change:** a `forRootAsync` factory returns the module options instead of the auth instance, and it runs while the application initializes: `useFactory: (env) => ({ issuer: 'accounts', auth: () => betterAuth({ ... }) })`. `issuer` comes from the factory; `basePath`, `mountHandler` and `globalGuard` go next to it. Options without an `auth` instance or function fail bootstrap.

**Behavior change:** registrations are keyed by their structural options instead of the auth instance or factory reference, so a second auth configuration with the same base path fails bootstrap instead of becoming another instance. The process-wide reference table is removed. `createBetterAuthCatchallController` returns one class per base path, so a registration imported twice mounts the handler once.

**Behavior change:** `identityFromUser` no longer sets the removed `userId` alias; read `subject` (with `issuer`).
