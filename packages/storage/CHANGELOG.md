# Changelog

## 1.31.0

### Minor Changes

- 1bfc1c1: `StorageModule` from `@velajs/storage` is the one storage module. Its `driver` may be a function of the application's `ENV`, called on the first storage operation of each application, so one static `StorageModule.forRoot` serves every environment without reading a binding at boot. On Cloudflare Workers, `r2Storage({ binding: 'UPLOADS' })` from the new `@velajs/cloudflare/storage` subpath is its native R2 driver: the bucket is resolved by name from `ENV` and validated, and a missing binding fails the operation naming `r2_buckets`. `@velajs/storage` is an optional peer of `@velajs/cloudflare`, needed only by that subpath.
  
  **Behavior change:** the Cloudflare `StorageModule` is removed, with `StorageService`, `StorageManagerService`, `StorageController`, `R2StorageDriver`, `STORAGE_OPTIONS` and the `StorageModuleOptions`, `DiskConfig` and `PresignedUrlConfig` types from `@velajs/cloudflare`. Register a `StorageModule.forRoot({ name, driver: r2Storage({ binding }) })` from `@velajs/storage` per former disk and inject its `StorageService` (`@InjectStorage(name)` for a named bucket). A disk's `root` becomes the bucket's `prefix`, which is static: the `{date}`, `{year}`, `{month}`, `{day}` and `{uuid}` tokens have no replacement, so build such keys in the application. Its HMAC presign-proxy route (`GET /storage/:disk`) is gone and URLs it issued stop working: serve downloads through `publicBaseUrl`, the authorized `http: { download: 'proxy' }` controller, or provider-signed URLs from the S3 or R2 HTTP/hybrid drivers.
  
  **Behavior change:** the `@velajs/vela/storage` subpath is removed with the second `StorageDriver` contract, `expandPathTemplate` and `joinStoragePath` it held for that module, and `STORAGE_SIGNED_URL_PURPOSE` leaves `@velajs/vela/security`. Use `@velajs/storage`'s driver contract and key helpers (`joinKey`, `normalizePrefix`, `sanitizeKey`); `signUrl` and `verifySignedUrl` stay on `@velajs/vela/security` with an application-chosen `purpose`.
- b227d22: Build `StorageModule` on `defineModule`. `name` and `http` are its structural options (`StorageStructuralOption`); the driver may be a function that builds it on the first storage operation (and again on the next one until it succeeds), and the top-level `multipartGrantSecret` option carries a secret from `ENV`.
  
  **Behavior change:** a `forRootAsync` factory returns the module options instead of a bare driver or `{ driver, multipartGrantSecret }`: `useFactory: (env) => ({ driver: () => r2Driver({ bucket: env.FILES }), multipartGrantSecret: env.SECRET })`, with `name` and `http` next to the factory. `prefix`, `readonly` and `hooks`, which `forRootAsync` took next to the factory, come from the factory result too. The factory runs while the application initializes; return `driver` as a function to keep construction on first use. `StorageAsyncResult` is removed.
  
  **Behavior change:** each bucket name is one module instance, keyed by the name (never by a secret). A second registration of a name with different options (another driver, `http` block or authorizer) fails bootstrap instead of becoming another instance, so two features that each need a bucket give them distinct names; and `key` is the standard explicit instance key rather than a namespace combined with the driver identity. The process-wide identity tables, including the one that retained secret strings, are removed.
  
  **Behavior change:** the deprecated `http.defaultPolicy` option is removed; HTTP routes deny every request without `authorize`, as before.
  
  `name` defaults to `'default'` as a structural default, so `forRoot({ driver })` and `forRoot({ driver, name: 'default' })` are one configuration.
- 3fc6f2b: The storage HTTP controller carries `SkipGuardPhases(['tenant', 'authorize'])` from `@velajs/vela/module-kit`, because its `http.authorize` callback decides every action: the global tenant and authorization guards whose class declares `static readonly skippable = true` (`TenantGuard`, `PermissionGuard`, `RolesGuard` and `CedarGuard`) do not run on its routes. Authentication, throttling and the other global guards still run there.
  
  **Behavior change:** those guards no longer run on storage routes, including one the application registers itself, such as `{ provide: APP_GUARD, useClass: TenantGuard }`, and an application guard that extends one without declaring `static override readonly skippable = false`. @velajs/storage 1.30.0 ran every global guard on these routes. Check tenant membership and permissions for storage actions in `http.authorize`, which receives the request (`{ req, ctx, driver }`).

### Patch Changes

- 3fc6f2b: The storage HTTP controller and the GraphQL endpoint inject the Hono context with `@Ctx()`, because `@Req()` injects the platform `Request` from @velajs/vela 1.31.0.
- 05bbfdf: Call the platform `fetch` without a receiver in the S3 client. On workerd, every S3 and R2-over-HTTP request made through the default `fetch` failed with "Illegal invocation" because the client invoked it as one of its own methods; Node accepted the call, so only Workers deployments were affected. A Workers-runtime test now covers the default transport.
- Updated dependencies [0b8c649]
- Updated dependencies [1011653]
- Updated dependencies [088f4d4]
- Updated dependencies [f267c2f]
- Updated dependencies [dfe925c]
- Updated dependencies [fd11d20]
- Updated dependencies [748e4f8]
- Updated dependencies [096e259]
- Updated dependencies [fd11d20]
- Updated dependencies [3418c55]
- Updated dependencies [fd11d20]
- Updated dependencies [d51dbb3]
- Updated dependencies [f267c2f]
- Updated dependencies [4a06057]
- Updated dependencies [f267c2f]
- Updated dependencies [1bfc1c1]
- Updated dependencies [f267c2f]
- Updated dependencies [f267c2f]
- Updated dependencies [1ef55ac]
- Updated dependencies [f267c2f]
- Updated dependencies [b227d22]
- Updated dependencies [2c92243]
  - @velajs/vela@1.31.0

## 1.30.0

### Minor Changes

- 4d0342b: Build on the tiered `@velajs/vela` entry points: module-author seams such as `Container`, `MetadataRegistry`, `DiscoveryService`, `PipelineRunner`, trusted request identity and entrypoint scopes come from `@velajs/vela/module-kit`, and features from their subpaths. The package's own exports are unchanged.
  
  **Behavior change:** this release requires the `@velajs/vela` release that introduces `@velajs/vela/module-kit` and the feature subpaths; upgrade both together. Application code that imported these framework names from the root moves them as follows (the `@velajs/vela` changelog lists every name):
  
  | Old import | New import | Examples |
  |---|---|---|
  | `@velajs/vela` | `@velajs/vela/module-kit` | `Container`, `MetadataRegistry`, `DiscoveryService`, `createDiscoverableDecorator`, `registerEntrypointKind`, `runInEntrypointScope`, `PipelineRunner`, `RuntimeAdapter`, `invokeScheduledJob`, `getRequestContainer`, `setTrustedRequestIdentity`, `resolveErrorReporter`, `lazyProvider`, `stableHash`, `defineMetadata` |
  | `@velajs/vela` | `@velajs/vela/cache`, `/throttler`, `/schedule`, `/events`, `/health`, `/logging`, `/http-client` | `CacheModule`, `ResponseCacheModule`, `ThrottlerModule`, `ScheduleModule`, `Cron`, `EventEmitterModule`, `HealthModule`, `LoggingModule`, `HttpModule` |
  | `@velajs/vela` | `@velajs/vela/openapi` | `Endpoint`, `defineEndpoint`, `createOpenApiDocument`, `ApiDoc`, `ApiTags`, `ApiResponse` |
  | `@velajs/vela` | `@velajs/vela/security`, `/dispatch` | `SecurityModule`, `CorsModule`, `signUrl`, `NONCE_STORE`; `InternalDispatcher`, `SignedInvocation` |
  | `@velajs/vela` | `@velajs/vela/validation`, `/websocket` | `ValidationPipe`, `defineDto`, `parseSchemaAsync`; `WebSocketGateway`, `WebSocketModule` |
  | `@velajs/vela/internal` | `@velajs/vela/module-kit` | `Container`, `MetadataRegistry` |

### Patch Changes

- Updated dependencies [4467619]
- Updated dependencies [7372d90]
- Updated dependencies [c101033]
- Updated dependencies [4d0342b]
  - @velajs/vela@1.30.0

## 1.29.0

### Minor Changes

- 4071cb7: A factory without parameters may omit `inject` in `BetterAuthModule.forRootAsync()`, `MailModule.forRootAsync()`, `StorageModule.forRootAsync()`, `RpcClientModule.registerAsync()` and `overrideProvider(token).useFactory({ factory })`, as in the `@velajs/vela` factories. A factory with parameters still names their tokens in `inject`, and a dependency tuple given as a type argument still needs a matching `inject`.
  
  `StorageModule.forRootAsync()` factories may return `{ driver, multipartGrantSecret }` instead of a bare driver, so the multipart grant secret comes through DI, for example from `ENV`, now that roots are static. The factory still runs once, on first use, or again on the next use until it succeeds; its secret takes precedence over `http.multipartGrantSecret` and is validated with the rest of the factory result on each such use, and multipart endpoints without any secret keep refusing every request. Adds the `StorageAsyncResult` and `StorageControllerOptions` types, and `createStorageController()` takes an optional token for the values it resolves per application.
  
  **Behavior change:** a multipart grant secret shorter than 32 bytes is a server configuration error instead of a client error. `StorageModule.forRoot()` throws for such an `http.multipartGrantSecret` when the module is set up, and a `forRootAsync()` factory that returns one fails every storage operation and multipart request until the factory returns a valid result, which the controller answers with a redacted 502 `upstream_error`. Multipart requests no longer answer 400 `invalid_request` with a message that names the setting.
  
  **Behavior change:** `MailModule.forRootAsync()` and `StorageModule.forRootAsync()` throw when called with a factory that declares parameters but no `inject`, naming the method, instead of running it with `undefined` arguments. `MailModuleAsyncOptions`, `StorageModuleAsyncOptions` and `RpcClientAsyncOptions` are type aliases instead of interfaces, so an interface can no longer extend them: intersect them instead (`RpcClientAsyncOptions<Inject> & { region: string }`). `MailModuleAsyncOptions.imports` is typed `ModuleImport[]`, so a caller that enables `exactOptionalPropertyTypes` omits it instead of passing `undefined`.
- d55987f: Read the storage HTTP control plane's request bodies with `readJsonBody` from `@velajs/vela`
  in `/sign-upload`, `/sign-download`, `/delete` and the `/multipart/*` endpoints.
  
  **Behavior change:** these endpoints refuse a body that is not `application/json` or a `+json`
  media type with 415 and `{ error: { code: 'invalid_request', message } }`, before the
  authorizer runs. Previously a cross-site `text/plain` POST, which browsers send without a CORS
  preflight, was parsed as JSON, so a page on another origin could make a cookie-authenticated
  user delete or sign objects. Malformed JSON and a missing or non-object body are now 400
  `invalid_request` instead of 502 `upstream_error` or 400 `invalid_key`. The
  `@velajs/storage/client` browser client already sends `application/json`.

### Patch Changes

- Updated dependencies [07d1713]
- Updated dependencies [db18d3a]
- Updated dependencies [07d1713]
- Updated dependencies [bacaacd]
- Updated dependencies [a814199]
- Updated dependencies [1838474]
- Updated dependencies [8a3016c]
- Updated dependencies [d803a49]
- Updated dependencies [b235935]
- Updated dependencies [08a81c8]
- Updated dependencies [5b5b81d]
- Updated dependencies [7daf4fc]
- Updated dependencies [35e8e0d]
- Updated dependencies [4420501]
- Updated dependencies [ff44b6a]
- Updated dependencies [6d4f0c0]
- Updated dependencies [e3bda2a]
- Updated dependencies [bd7e3c9]
- Updated dependencies [2b74880]
- Updated dependencies [5ba8635]
- Updated dependencies [db0c834]
- Updated dependencies [d6f6a65]
- Updated dependencies [8a3016c]
- Updated dependencies [d5a3ec8]
- Updated dependencies [0f7e8e7]
- Updated dependencies [41ec70d]
- Updated dependencies [b265297]
- Updated dependencies [bdfff47]
- Updated dependencies [28c7d07]
- Updated dependencies [8a3016c]
- Updated dependencies [44efdde]
  - @velajs/vela@1.29.0

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

### Patch Changes

- Updated dependencies
  - @velajs/vela@1.28.0

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/vela@3.0.0

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [b99d71a]
  - @velajs/vela@2.0.0

## 1.23.0

### Minor Changes

- 5bbbe6b: Add metadata-only stat/listMetadata access and preserve exact native raw binding types through storage facades, services, R2/hybrid drivers, and built-in middleware. Add explicit R2 listing metadata inclusion and Workers-native type coverage. Clarify portable storage versus the compatible legacy Cloudflare HMAC proxy API.

### Patch Changes

- 6588211: Normalize generated CRUD names and storage prefixes in linear passes so long
  separator runs cannot cause regular-expression backtracking. Preserve existing
  operation IDs, controller/DTO names, and prefix scoping behavior.
- 4bf9081: Report actual native R2 range lengths and reject invalid ranges before I/O. Enforce storage deadlines and cancellation without retrying abandoned operations whose writes may still commit. Dispose late download bodies and multipart handles, stop follow-up mutations after cancellation, and document provider-side uncertainty and stream ownership.
- Updated dependencies [c6a43a6]
- Updated dependencies [bbe62d4]
- Updated dependencies [a6ef933]
- Updated dependencies [dae3654]
- Updated dependencies [77cca9e]
- Updated dependencies [b9f75f5]
- Updated dependencies [df47ea8]
- Updated dependencies [af019bf]
- Updated dependencies [6df1059]
- Updated dependencies [bdd90a1]
- Updated dependencies [8a3923f]
- Updated dependencies [c7d108b]
- Updated dependencies [1c7f635]
- Updated dependencies [636ffbc]
- Updated dependencies [54f8864]
- Updated dependencies [f49db45]
- Updated dependencies [4fde903]
- Updated dependencies [6a1b5b3]
- Updated dependencies [a95951a]
- Updated dependencies [9e82187]
- Updated dependencies [c5a3cb0]
- Updated dependencies [363fb71]
- Updated dependencies [de4e57e]
- Updated dependencies [0765aaa]
- Updated dependencies [6b7cf23]
- Updated dependencies [5205e58]
- Updated dependencies [ae45689]
  - @velajs/vela@1.25.0

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/vela@1.22.1

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/vela@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/vela@2.0.1

## 2.0.0

Native Workers bindings and checked schema boundaries; validated against real workerd bindings.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.0.0

### Major Changes

- 38f91ae: Secure browser-direct multipart uploads with actor-bound, key-bound, staging-key-bound, size-bound, part-count-bound, expiring HMAC grants. Multipart HTTP clients must now send the exact object size at creation and echo the returned grant on part signing, completion, and abort requests. Completion occurs under a reserved quarantine key and promotes the object only after validation. Storage dynamic-module identity now includes driver/factory, hooks, authorizer, and multipart-secret identity so distinct security configurations cannot collapse. HTTP routes are deny-only without an explicit authorizer; the insecure `defaultPolicy: 'allow'` compatibility path is removed. Proxy downloads now default to attachment, block HTML/SVG inline rendering, and emit `X-Content-Type-Options: nosniff`. Browser-facing `/sign-download` URLs now resolve object metadata and bind an attachment `Content-Disposition` into the provider signature.

## 0.3.2

### Patch Changes

- cb3140a: Modernize the package build, validation, and release toolchain.

## 0.2.0 (2026-07-04)

- Rebuilt on vela 1.11 `defineModule` + `lazyProvider` (hand-rolled forRoot/forRootAsync deleted; public API byte-identical). Requires `@velajs/vela >=1.11.0`.

## 0.1.0 (unreleased)

- Initial release: edge-first, driver-based object/file storage for Vela.
  - `StorageModule` (`forRoot` / `forRootAsync`) with multi-bucket named instances.
  - `Storage` facade with capability-gating, retry/timeout/abort, and multipart orchestration.
  - Drivers: in-memory, S3 / S3-compatible (aws4fetch SigV4), R2 native binding, R2 over HTTP + hybrid.
  - Opt-in `storageSdkDriver()` bridge for `@storagesdk/adapters` (Node/Bun).
