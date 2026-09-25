---
'@velajs/storage': minor
---

Build `StorageModule` on `defineModule`. `name` and `http` are its structural options (`StorageStructuralOption`); the driver may be a function that builds it on the first storage operation (and again on the next one until it succeeds), and the top-level `multipartGrantSecret` option carries a secret from `ENV`.

**Behavior change:** a `forRootAsync` factory returns the module options instead of a bare driver or `{ driver, multipartGrantSecret }`: `useFactory: (env) => ({ driver: () => r2Driver({ bucket: env.FILES }), multipartGrantSecret: env.SECRET })`, with `name` and `http` next to the factory. `prefix`, `readonly` and `hooks`, which `forRootAsync` took next to the factory, come from the factory result too. The factory runs while the application initializes; return `driver` as a function to keep construction on first use. `StorageAsyncResult` is removed.

**Behavior change:** each bucket name is one module instance, keyed by the name (never by a secret). A second registration of a name with different options (another driver, `http` block or authorizer) fails bootstrap instead of becoming another instance, so two features that each need a bucket give them distinct names; and `key` is the standard explicit instance key rather than a namespace combined with the driver identity. The process-wide identity tables, including the one that retained secret strings, are removed.

**Behavior change:** the deprecated `http.defaultPolicy` option is removed; HTTP routes deny every request without `authorize`, as before.

`name` defaults to `'default'` as a structural default, so `forRoot({ driver })` and `forRoot({ driver, name: 'default' })` are one configuration.
