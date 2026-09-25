---
'@velajs/storage': minor
'@velajs/cloudflare': minor
'@velajs/vela': minor
---

`StorageModule` from `@velajs/storage` is the one storage module. Its `driver` may be a function of the application's `ENV`, called on the first storage operation of each application, so one static `StorageModule.forRoot` serves every environment without reading a binding at boot. On Cloudflare Workers, `r2Storage({ binding: 'UPLOADS' })` from the new `@velajs/cloudflare/storage` subpath is its native R2 driver: the bucket is resolved by name from `ENV` and validated, and a missing binding fails the operation naming `r2_buckets`. `@velajs/storage` is an optional peer of `@velajs/cloudflare`, needed only by that subpath.

**Behavior change:** the Cloudflare `StorageModule` is removed, with `StorageService`, `StorageManagerService`, `StorageController`, `R2StorageDriver`, `STORAGE_OPTIONS` and the `StorageModuleOptions`, `DiskConfig` and `PresignedUrlConfig` types from `@velajs/cloudflare`. Register a `StorageModule.forRoot({ name, driver: r2Storage({ binding }) })` from `@velajs/storage` per former disk and inject its `StorageService` (`@InjectStorage(name)` for a named bucket). Its HMAC presign-proxy route (`GET /storage/:disk`) is gone and URLs it issued stop working: serve downloads through `publicBaseUrl`, the authorized `http: { download: 'proxy' }` controller, or provider-signed URLs from the S3 or R2 HTTP/hybrid drivers.

**Behavior change:** the `@velajs/vela/storage` subpath is removed with the second `StorageDriver` contract, `expandPathTemplate` and `joinStoragePath` it held for that module, and `STORAGE_SIGNED_URL_PURPOSE` leaves `@velajs/vela/security`. Use `@velajs/storage`'s driver contract and key helpers (`joinKey`, `normalizePrefix`, `sanitizeKey`); `signUrl` and `verifySignedUrl` stay on `@velajs/vela/security` with an application-chosen `purpose`.
