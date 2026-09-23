# Cloudflare Workers

Use native platform bindings through a typed environment token. `@velajs/cloudflare` supplies HTTP, queue, cron, and live transports; its root entrypoint is safe for Node tooling. Native Durable Object classes live in `@velajs/cloudflare/durable-objects`.

## Worker and environment

```ts
import { Inject, Injectable, InjectionToken, Module } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';

interface WorkerEnv { DB: D1Database; CACHE: KVNamespace; FILES: R2Bucket }
export const ENV = new InjectionToken<WorkerEnv>('app.Env');

@Injectable()
class UsersService {
  constructor(@Inject(ENV) private readonly env: WorkerEnv) {}
  find(id: string) {
    return this.env.DB.prepare('select * from users where id = ?').bind(id).first();
  }
}

@Module({ providers: [UsersService] })
class AppModule {}
export default createCloudflareWorker(AppModule, { envToken: ENV });
```

Generate native environment types with the application's Wrangler configuration. Inject `ENV` directly or derive a narrower binding token with `defineProvider(TOKEN, { inject: [ENV], useFactory: env => env.DB })`. Binding wrapper modules/services are not part of the API.

The worker exposes `fetch`, `queue`, and `scheduled`. Applications are cached by environment object identity; concurrent first events share bootstrap, different environments get separate applications, and failed bootstrap retries on the next event. For explicit construction use `createCloudflareApp(AppModule, { env, envToken: ENV })` or `cloudflareAdapter({ env, envToken: ENV })`. Bindings exist before DI factories run; binding I/O still belongs inside a platform event. An explicitly constructed app rejects events from another environment.

## Queue and cron handlers

Register `@Injectable()` providers with `@QueueConsumer('queue-name')` or `@Scheduled('cron expression')`. Core `@Cron` also runs on scheduled triggers. Parse `MessageBatch<unknown>` bodies before reading application fields. Each dispatch uses a fresh scope and its declared guards/interceptors/filters; unhandled errors reach the platform for retry. These cold entrypoints receive the same native bindings as HTTP.

## Durable Objects and live queries

```ts
import { LiveModule } from '@velajs/vela/live';
import { CloudflareWebSocketModule, durableObjectCursorLog, durableObjectLive } from '@velajs/cloudflare';
import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';

// ENV includes ROOMS: DurableObjectNamespace<Room>.
@Module({
  imports: [
    CloudflareWebSocketModule.forRoot(),
    LiveModule.forRootAsync({
      inject: [ENV],
      useFactory: (env) => ({
        driver: () => durableObjectLive({ namespace: env.ROOMS, gatewayPath: '/rooms/:room/ws' }),
        log: () => durableObjectCursorLog(),
      }),
    }),
  ],
  providers: [RoomsGateway, TodoLive],
})
class RoomModule {}
export class Room extends VelaWebSocketDurableObject(RoomModule, { envToken: ENV }) {}
```

Import native classes only in Worker entry files. Configure the namespace and `new_sqlite_classes` migration in Wrangler. Gateway options declare `path`, `roomParam`, `binding`, origins, and upgrade authentication. Core trusted identity, tenant, and expiry cross the upgrade boundary; caller-supplied identity headers are not authority. Driver/log factories return fresh state per application. Read `live-queries.md` for shared query schemas and delivery authorization.

## Storage, caches, and flags

R2 storage options contain actual bucket values (`disks: [{ disk: 'uploads', bucket: env.FILES }]`) and an explicit signing `secret`; resolve them with `StorageModule.forRootAsync({ inject: [ENV], useFactory: ... })`.

For response caching, use core `ResponseCacheModule` with `KVCacheStore` and optional `KVCacheInvalidationStore` in a separate non-expiring namespace. KV logical TTL is preserved in metadata; distributed invalidation remains eventually consistent.

Use `new KVCacheStore(env.CACHE)`, `kvFlagDriver(env.CACHE, options)`, and `flagshipFlagDriver(nativeBinding, options)`. Cache/object flag values remain unknown until parsed. There is no generic binding accessor that invents their value type.

The `@velajs/vela` root entry imports `hono/context-storage` (`node:async_hooks`) whether or not ambient access is used. `nodejs_compat` provides it and is default-on from compatibility date 2026-08-04; with an earlier date add `nodejs_als` (or `nodejs_compat`). Vela's Cloudflare and Durable Object transports need no other Node.js APIs; add `nodejs_compat` only for dependencies that import other `node:*` modules. Ambient container access is optional; per-request DI works without ambient state. On Workers stamp live commit headers explicitly instead of relying on ALS across DO RPC. See the Cloudflare package README and `apps/live-todo` for the complete deployed wiring.
