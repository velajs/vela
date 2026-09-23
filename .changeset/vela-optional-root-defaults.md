---
'@velajs/vela': patch
---

Ship `Reflector` and the signed-URL and signed-dispatch services only with Workers that use them. `Reflector`, `UrlGeneratorService`, `SignedUrlGuard`, `InternalDispatcher`, `SignedInvocationGuard` and the `MemoryNonceStore` default for `NONCE_STORE` now declare themselves when their modules load, and `bootstrap` registers every declared service as before: an application-wide singleton that any module can inject, that one `@Global()` module exporting the token overrides, and that the application's own configuration (the `env` option, a runtime adapter, testing overrides) replaces. A bundle that never references one of them no longer contains it; together they took 4,413 bytes gzipped off the reference Worker.

A service whose module is first imported after the application was created, through a dynamic `import()`, registers the first time the application resolves it, with the same standing: one application-wide singleton, request-scoped when it injects a request-scoped provider, and still overridden by a `@Global()` module exporting its token or by the application's own configuration.
