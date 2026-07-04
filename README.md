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

@Module({
  imports: [
    StorageModule.forRootAsync({
      inject: [EnvService],
      useFactory: (env) =>
        s3Driver({
          endpoint: 'https://s3.us-east-1.amazonaws.com',
          region: 'us-east-1',
          bucket: 'my-bucket',
          credentials: { accessKeyId: env.get('AWS_KEY'), secretAccessKey: env.get('AWS_SECRET') },
        }),
    }),
  ],
})
class AppModule {}
```

## Drivers

| Driver | Import | Edge? | Presign |
|---|---|---|---|
| Memory (tests) | `@velajs/storage/drivers/memory` | ✅ | ❌ |
| S3 / S3-compatible | `@velajs/storage/drivers/s3` | ✅ | ✅ |
| R2 (native binding) | `@velajs/storage/drivers/r2` | ✅ | via hybrid |
| R2 (HTTP + hybrid) | `@velajs/storage/drivers/r2-http` | ✅ | ✅ |
| storagesdk bridge | `@velajs/storage/storagesdk` | Node/Bun only | depends on adapter |

See the docs site for presigned uploads, the HTTP upload controller + browser client, middleware,
multi-bucket, and the full capability matrix.
