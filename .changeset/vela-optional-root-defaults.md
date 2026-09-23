---
'@velajs/vela': patch
---

Ship `Reflector` and the signed-URL and signed-dispatch services only with Workers that use them. `Reflector`, `UrlGeneratorService`, `SignedUrlGuard`, `InternalDispatcher`, `SignedInvocationGuard` and the `MemoryNonceStore` default for `NONCE_STORE` now declare themselves when their modules load, and `bootstrap` registers every declared service as before: an application-wide singleton that any module can inject, that one `@Global()` module exporting the token overrides, and that the application's own configuration (the `env` option, a runtime adapter, testing overrides) replaces. A bundle that never references one of them no longer contains it; together they took 4,413 bytes gzipped off the reference Worker.

A service referenced only from code that is first imported after the application was created, through a dynamic `import()`, is not registered in that application. Import it statically, as any provider in the module graph already is.
