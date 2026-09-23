---
'@velajs/better-auth': minor
'@velajs/mail': minor
'@velajs/rpc': minor
'@velajs/storage': minor
'@velajs/testing': minor
---

A factory without parameters may omit `inject` in `BetterAuthModule.forRootAsync()`, `MailModule.forRootAsync()`, `StorageModule.forRootAsync()`, `RpcClientModule.registerAsync()` and `overrideProvider(token).useFactory({ factory })`, as in the `@velajs/vela` factories. A factory with parameters still names their tokens in `inject`, and a dependency tuple given as a type argument still needs a matching `inject`.

`StorageModule.forRootAsync()` factories may return `{ driver, multipartGrantSecret }` instead of a bare driver, so the multipart grant secret comes through DI, for example from `ENV`, now that roots are static. The factory still runs once, on first use; its secret takes precedence over `http.multipartGrantSecret`, is validated when a grant is issued or verified, and multipart endpoints without any secret keep refusing every request. Adds the `StorageAsyncResult` and `StorageControllerOptions` types, and `createStorageController()` takes an optional token for the values it resolves per application.

**Behavior change:** `MailModule.forRootAsync()` and `StorageModule.forRootAsync()` throw when called with a factory that declares parameters but no `inject`, naming the method, instead of running it with `undefined` arguments. `MailModuleAsyncOptions`, `StorageModuleAsyncOptions` and `RpcClientAsyncOptions` are type aliases instead of interfaces, so an interface can no longer extend them: intersect them instead (`RpcClientAsyncOptions<Inject> & { region: string }`). `MailModuleAsyncOptions.imports` is typed `ModuleImport[]`, so a caller that enables `exactOptionalPropertyTypes` omits it instead of passing `undefined`.
