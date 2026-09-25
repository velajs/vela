# Storage (`@velajs/storage`)

A full driver-based object-storage system for Vela: a `StorageService` with upload/download/list/presign, pluggable drivers (memory / S3 / R2 / R2-over-HTTP), an optional HTTP upload controller, and framework-free test helpers. Its only runtime dependency is `aws4fetch` (for SigV4 presigning). Subpaths include `.`, `./drivers/memory`, `./drivers/s3`, `./drivers/r2`, `./drivers/r2-http`, `./middleware`, and `./testing`.

> **One storage module.** `StorageModule` from `@velajs/storage` is the only one. On Cloudflare Workers, `r2Storage({ binding: 'UPLOADS' })` from `@velajs/cloudflare/storage` is its native R2 driver, resolved from each application's `ENV` by binding name. There is no `@velajs/vela/storage` subpath and no Cloudflare `StorageModule`.

## Setup — `StorageModule.forRoot`

You build a driver (from a `./drivers/*` subpath) and hand the instance to the module:

```ts
import { StorageModule } from '@velajs/storage';
import { s3Driver } from '@velajs/storage/drivers/s3';

@Module({
  imports: [
    StorageModule.forRoot({
      driver: s3Driver({ endpoint, region: 'auto', bucket: 'uploads', credentials: { accessKeyId, secretAccessKey } }),
      prefix: 'tenant-a/',   // optional key prefix
    }),
  ],
})
class AppModule {}
```

`StorageModuleOptions`: `driver` (a built `StorageDriver`, or a function `(env) => StorageDriver` that builds one from the application's `ENV` on its first operation; required), `name?` (default `'default'`), `prefix?`, `readonly?`, `hooks?`, `http?` (mounts the HTTP controller) and `multipartGrantSecret?`. `name` and `http` are structural: `forRootAsync({ inject?, imports, useFactory, name?, http?, key? })` takes them at the call site and its `useFactory` returns the rest, such as `{ driver: r2Storage({ binding: 'FILES' }), multipartGrantSecret: env.GRANT_SECRET }`; a factory without parameters may omit `inject`. One instance per bucket `name`: a second configuration of a name fails bootstrap in every diagnostics mode, so give each feature's bucket its own `name`. The `driver` is a value, not a string — there is no name-based selector.

`StorageHttpOptions` (when `http` is set): `basePath` (default `/api/storage`), `authorize` (routes deny without it), `download` (`'redirect'` default | `'proxy'`), `mountController`, `defaultExpiresIn`, `maxExpiresIn`, `maxUploadSize`, `multipartGrantSecret`, `maxMultipartParts`, `maxListLimit`, `deleteConcurrency`.

## Drivers

| Import from | Factory | Config |
|---|---|---|
| `@velajs/storage/drivers/memory` | `memoryDriver(opts?)` | `{ initial? }` — in-memory; the test fake |
| `@velajs/storage/drivers/s3` | `s3Driver(opts)` | `{ endpoint, region, bucket, credentials: { accessKeyId, secretAccessKey, sessionToken? }, forcePathStyle?, publicBaseUrl?, defaultUrlExpiresIn?, fetch?, name? }` |
| `@velajs/storage/drivers/r2` | `r2Driver(opts)` | `{ bucket: R2BucketLike binding, publicBaseUrl?, includeMetadata?, name? }` — native binding (`R2BucketLike` is a structural subset type), zero deps |
| `@velajs/cloudflare/storage` | `r2Storage(opts)` | `{ binding: 'UPLOADS', publicBaseUrl?, includeMetadata?, name? }` — `r2Driver` over the bucket named in the Wrangler `r2_buckets`, read from each application's `ENV` on first use; a static `StorageModule.forRoot({ driver: r2Storage({ binding }) })` |
| `@velajs/storage/drivers/r2-http` | `r2HttpDriver(opts)` / `r2HybridDriver(opts)` | `{ accountId, accessKeyId, secretAccessKey, bucket, endpoint?, publicBaseUrl?, … }` (hybrid adds `binding`) |

`s3Driver` and the R2-HTTP drivers support presigned upload + download URLs; `r2Driver` (native binding) supports downloads via `publicBaseUrl` but not presigned uploads. Use `s3Driver({ region: 'auto', forcePathStyle: true })` (or `r2HttpDriver`) for R2 over the S3 API.

## Using the service — `StorageService`

Inject `StorageService` (or use the `@InjectStorage()` decorator / `storageToken(name)` for a named disk):

```ts
@Injectable()
class AvatarsService {
  constructor(private readonly storage: StorageService) {}

  async save(key: string, bytes: Uint8Array) {
    await this.storage.upload(key, bytes);
    return this.storage.url(key, { expiresIn: 3600 });   // presigned GET
  }
}
```

Service methods: `upload(key, body, opts?)`, `download(key, opts?)`, `head(key, opts?)`, `exists(key, opts?)`, `delete(key, opts?)`, `deleteMany(keys, opts?)`, `copy(from, to, opts?)`, `move(from, to, opts?)`, `list(opts?)`, `url(key, opts?)`, `signedUploadUrl(key, opts)`. The richer facade (multipart, `listAll()` async iteration, `file(key)` handles, `signedMultipart`) is reachable via `service.storage`.

Use `stat(key)` and `listMetadata(opts?)` for frozen metadata snapshots without
body streams or mutable native objects. Native R2 range results distinguish the
returned byte length from the full object's size. `createStorage`, its service,
and middleware preserve the driver's generic raw binding type; keep native
bindings inferred instead of widening them to the structural driver constraint.

Operation aborts and deadlines stop waiting and are terminal for retry
middleware. An already-issued native write may still complete. Do not retry an
uncertain write automatically or describe cancellation as rollback.

## Presigned URLs

Signing runs on `aws4fetch` + Web Crypto (edge-safe). `url(key, { expiresIn?, responseContentDisposition? })` returns a download URL (a public `publicBaseUrl` link when possible, else a presigned GET). `signedUploadUrl(key, { expiresIn, contentType?, maxSize?, minSize? })` returns a `SignedUpload` — either `{ method: 'PUT', url, headers? }`, or, when size bounds are set, a POST-policy `{ method: 'POST', url, fields }` your client submits directly.

## Testing — `@velajs/storage/testing`

Framework-free assertions (plain `Error`, no vitest dependency) over any storage target — a `StorageService`, the `Storage` facade, or a bare driver:

```ts
import { assertExists, assertMissing, assertCount } from '@velajs/storage/testing';
import { memoryDriver } from '@velajs/storage/drivers/memory';
import { createStorage } from '@velajs/storage';

const storage = createStorage({ driver: memoryDriver() });
await storage.upload('avatars/1.png', bytes);

await assertExists(storage, 'avatars/1.png');
await assertMissing(storage, 'avatars/2.png');
await assertCount(storage, 'avatars/', 1);   // prefix-scoped; or assertCount(storage, 1) for the whole disk
```

`assertExists(storage, key)`, `assertMissing(storage, key)`, and `assertCount(storage, expected)` / `assertCount(storage, prefix, expected)` are the three helpers; a failing `assertExists` throws with the list of stored keys.
