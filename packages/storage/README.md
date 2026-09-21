# @velajs/storage

Edge-first, driver-based object/file storage for the [Vela](https://github.com/velajs/vela) framework.

Runs on Cloudflare Workers, Deno, Bun, Node 20+, and Vercel Edge — **no AWS SDK, ever**. S3/R2
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
import { InjectionToken, Module } from '@velajs/vela';

interface Env { AWS_KEY: string; AWS_SECRET: string }
const ENV = new InjectionToken<Env>('app.env');

@Module({
  imports: [
    StorageModule.forRootAsync({
      inject: [ENV],
      useFactory: (env) =>
        s3Driver({
          endpoint: 'https://s3.us-east-1.amazonaws.com',
          region: 'us-east-1',
          bucket: 'my-bucket',
          credentials: { accessKeyId: env.AWS_KEY, secretAccessKey: env.AWS_SECRET },
        }),
    }),
  ],
})
class AppModule {}
```

Supply `ENV` through `createCloudflareWorker(AppModule, { envToken: ENV })` from
`@velajs/cloudflare`. Async registrations require the actual `inject` tuple;
use `inject: []` for a factory with no dependencies.

## Secure HTTP multipart uploads

Browser-direct multipart uploads use a stateless HMAC grant bound to the authenticated actor, object key, provider upload ID, exact byte size, part count, and expiry. Configure a stable secret of at least 32 bytes and return a server-derived `actorId` from the authorizer:

```ts
StorageModule.forRoot({
  driver,
  http: {
    multipartGrantSecret: env.STORAGE_MULTIPART_GRANT_SECRET,
    maxUploadSize: 100 * 1024 * 1024,
    maxMultipartParts: 1000,
    authorize: (_action, { ctx }) => ({ actorId: ctx.get('user').id }),
  },
});
```

The browser client sends the exact file size when creating an upload and echoes the returned grant for part signing, completion, and abort. Multipart data is completed into a reserved quarantine key, verified there, and only then promoted to the requested key. A mismatched, oversized, or unreadable result is never exposed at the requested key. HTTP downloads default to `attachment`; both `/download` redirects and `/sign-download` URLs bind an attachment `Content-Disposition`, proxy responses emit `X-Content-Type-Options: nosniff`, and HTML/SVG are never served inline.

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
