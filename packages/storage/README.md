# @velajs/storage

Edge-first, driver-based object/file storage for the [Vela](https://github.com/velajs/vela) framework.

Runs on Cloudflare Workers, Deno, Bun, Node 24+, and Vercel Edge — **no AWS SDK, ever**. S3/R2
requests are signed with [`aws4fetch`](https://github.com/mhart/aws4fetch) (`fetch` + Web Crypto),
so the whole default path passes Vela's `edge-runtime-audit` gate.

## Why not just wrap files-sdk / storagesdk?

Both are great libraries, but their object-store adapters statically import the AWS SDK v3 (~500KB,
breaks on Workers). `@velajs/storage` owns an **edge-native `StorageDriver` contract** and ships
first-party drivers that sign with `aws4fetch`. You can still reach the wider ecosystem through the
opt-in `storageSdkDriver()` bridge (`@velajs/storage/storagesdk`) on Node/Bun.

## Install

```sh
pnpm add @velajs/storage
```

## Quick start

```ts
import { StorageModule, StorageService } from '@velajs/storage';
import { s3Driver } from '@velajs/storage/drivers/s3';
import { ENV, Module } from '@velajs/vela';

@Module({
  imports: [
    StorageModule.forRootAsync({
      inject: [ENV],
      useFactory: (env) => ({
        driver: s3Driver({
          endpoint: 'https://s3.us-east-1.amazonaws.com',
          region: 'us-east-1',
          bucket: 'my-bucket',
          credentials: { accessKeyId: env.AWS_KEY, secretAccessKey: env.AWS_SECRET },
        }),
      }),
    }),
  ],
})
class AppModule {}
```

`ENV` is the application's runtime environment. On Workers,
`createCloudflareWorker(AppModule)` from `@velajs/cloudflare` seeds it, and
`wrangler types` types `AWS_KEY` and `AWS_SECRET` from `.dev.vars`; elsewhere,
pass `VelaFactory.create(AppModule, { env })`. An async registration names the
tokens its factory's parameters receive in `inject`; a factory without
parameters may omit it.

The factory returns the module options. `name` (the bucket, default
`'default'`) and `http` are structural: they decide the provided tokens and the
mounted routes, so `forRootAsync` takes them next to the factory. The driver
may be a function, `driver: () => r2Driver({ bucket: env.UPLOADS })`, which
builds it on the first storage operation. Each bucket name is one module
instance; registering a name again with another driver, `http` block or other
options fails bootstrap, so two features that each need a bucket give them
distinct names (`name: 'avatars'`).

## Secure HTTP multipart uploads

Browser-direct multipart uploads use a stateless HMAC grant bound to the authenticated actor, object key, provider upload ID, exact byte size, part count, and expiry. Configure a stable secret of at least 32 bytes and return a server-derived `actorId` from the authorizer. A secret from the runtime environment comes through DI: the `forRootAsync` factory returns it next to the driver.

```ts
StorageModule.forRootAsync({
  inject: [ENV],
  useFactory: (env) => ({
    driver: r2Driver({ bucket: env.UPLOADS }),
    multipartGrantSecret: env.STORAGE_MULTIPART_GRANT_SECRET,
  }),
  http: {
    maxUploadSize: 100 * 1024 * 1024,
    maxMultipartParts: 1000,
    authorize: (_action, { ctx }) => ({ actorId: ctx.get('user').id }),
  },
});
```

The factory runs once, while the application initializes; a driver function it returns runs on the first storage operation, or again on the next one until it succeeds. The top-level `multipartGrantSecret` takes precedence over `http.multipartGrantSecret`, which suits a secret known at module scope. Without a secret, the multipart endpoints refuse every request with 403. A secret shorter than 32 bytes is a configuration error, not a client error: `http.multipartGrantSecret` throws when the module is set up, and a short top-level secret fails every multipart request, which the controller answers with a redacted server error (502 `upstream_error`).

The browser client sends the exact file size when creating an upload and echoes the returned grant for part signing, completion, and abort. Multipart data is completed into a reserved quarantine key, verified there, and only then promoted to the requested key. A mismatched, oversized, or unreadable result is never exposed at the requested key. HTTP downloads default to `attachment`; both `/download` redirects and `/sign-download` URLs bind an attachment `Content-Disposition`, proxy responses emit `X-Content-Type-Options: nosniff`, and HTML/SVG are never served inline.

The HTTP control plane's POST endpoints accept only `application/json` or `+json` bodies, because browsers send `text/plain` and form-encoded POSTs cross-site without a CORS preflight. Any other media type is refused with 415 before the authorizer runs, and a malformed or non-object body is a 400 `invalid_request`. The `@velajs/storage/client` browser client already sends JSON.

## Drivers

| Driver | Import | Edge? | Presign |
|---|---|---|---|
| Memory (tests) | `@velajs/storage/drivers/memory` | ✅ | ❌ |
| S3 / S3-compatible | `@velajs/storage/drivers/s3` | ✅ | ✅ |
| R2 (native binding) | `@velajs/storage/drivers/r2` | ✅ | via hybrid |
| R2 (HTTP + hybrid) | `@velajs/storage/drivers/r2-http` | ✅ | ✅ |
| storagesdk bridge | `@velajs/storage/storagesdk` | Node/Bun only | depends on adapter |

## Testing

There's no separate storage fake — the **memory driver IS the fake**. Build a disk in one line and
assert against it with the helpers from `@velajs/storage/testing`:

```ts
import { createStorage } from '@velajs/storage';
import { memoryDriver } from '@velajs/storage/drivers/memory';
import { assertExists, assertMissing, assertCount } from '@velajs/storage/testing';

const storage = createStorage({ driver: memoryDriver() });
await storage.upload('avatars/1.png', bytes);

await assertExists(storage, 'avatars/1.png');
await assertMissing(storage, 'avatars/2.png');
await assertCount(storage, 'avatars/', 1); // or assertCount(storage, 1) for the whole disk
```

The helpers accept anything memory-backed — a `Storage` facade or an injected `StorageService`.
For DI/integration tests, register the same driver instead: `StorageModule.forRoot({ driver: memoryDriver() })`.

See the docs site for presigned uploads, the HTTP upload controller + browser client, middleware,
multi-bucket, and the full capability matrix.

## Deadlines and stream ownership

`timeout` bounds the wait for an operation; `signal` stops that wait when aborted.
Both signal cooperative drivers, but native R2 binding I/O can still complete,
including a write whose caller has already received `Timeout` or `Aborted`.
Locally timed-out or cancelled operations are never retried, even with `retries`
or the retry middleware enabled. A rejected write is not proof that no write
occurred; reconcile its key before deciding whether to issue another mutation.
Settled retryable provider errors retain the configured retry policy.

Controls end when the operation returns. A successfully delivered download body
belongs to the caller: consume or cancel it explicitly. Abandoned downloads cancel
a body if it arrives later; multipart upload cancellation stops scheduling parts
and attempts to abort the upload. Cleanup cannot guarantee that an already-issued
native operation was rolled back. `head()` and `list()` retain their 1.x lazy body
readers; those later reads are separate from the original operation's deadline.

R2 range reads report the returned byte length, including ranges clipped at EOF,
without buffering the stream. Invalid ranges fail before binding I/O.

## Metadata and native binding types

Use `stat(key)` or `listMetadata(options)` when browsing metadata. They return
plain `StoredFileMetadata` snapshots without body readers, while `head()` and
`list()` keep their existing 1.x lazy readers. Fetch bytes explicitly through
`download(key, { signal, timeout })` when a later read needs operation controls.
Metadata methods do not issue extra per-object GET or HEAD requests.

```ts
import { createStorage } from '@velajs/storage';
import { r2Driver } from '@velajs/storage/drivers/r2';

// env.FILES uses the R2Bucket type from your generated Workers environment.
const files = createStorage({
  driver: r2Driver({ bucket: env.FILES, includeMetadata: true }),
  prefix: 'uploads',
});
const meta = await files.stat('report.csv');
const page = await files.listMetadata({ delimiter: '/', limit: 100 });
if (page.hasMore) {
  const next = await files.listMetadata({ delimiter: '/', cursor: page.cursor });
}
```

`includeMetadata: true` is an R2 binding/hybrid driver option requesting HTTP and
custom metadata in listings. Without it, R2 list results may omit custom metadata
and use the fallback content type. Other drivers return the metadata already
available from their listings. Metadata-rich pages can be shorter; follow
`hasMore` and `cursor`, including when a page contains only folder prefixes.

`files.raw` retains the exact supplied native binding type. `readonly()` views,
`lazyDriver()`, directly constructed `StorageService` instances, and built-in
middleware composition preserve that type. Custom `Middleware` remains supported;
its composition returns unknown raw types unless it implements the additive
`RawPreservingMiddleware` contract. `raw` is the original handle and bypasses
prefixes, readonly checks, middleware, and facade controls; use native keys there.
Named module injection still exposes `StorageService<unknown>`; inject your typed
`ENV` token when an injected consumer needs full native methods.

## Portable storage and the Cloudflare proxy

For new file/object storage, use `StorageModule` from `@velajs/storage` and choose
a driver through its independent import. Keep native `env.CACHE`, `env.DB`, and
Durable Object storage for KV, SQL and per-object transactions; these are separate
capabilities, not file-storage backends.

`@velajs/cloudflare` also exports an older `StorageModule` and `StorageService`.
That API stays supported in 1.x and signs Worker proxy routes with an application
HMAC secret. Its signed URLs are not interchangeable with S3/R2 provider-signed
URLs from the portable package. Migration is explicit:

| Cloudflare proxy API | Portable package |
| --- | --- |
| Configure `disks` with native buckets | Register a named `StorageModule` per driver |
| Driver `upload(body, path, { mimeType })` | `upload(key, body, { contentType })` |
| `download(path).toStream()` | `(await download(key)).stream()` |
| Worker HMAC `getPresignedUrl()` routes | Provider signing through S3 or R2 HTTP/hybrid drivers; optional authorized HTTP controller |

Keep existing proxy routes and issued URL handling during a migration. Neither
package requires migrating the other, and the legacy runtime/signatures are unchanged.
