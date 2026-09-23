# Cloudflare Workers

Use native platform bindings through the framework `ENV`, typed by `wrangler types`. `@velajs/cloudflare` supplies HTTP, queue, cron, and live transports; its root entrypoint is safe for Node tooling. Native Durable Object classes live in `@velajs/cloudflare/durable-objects`.

## Worker and environment

```ts
import { InjectEnv, Injectable, Module, type VelaEnv } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';

@Injectable()
class UsersService {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}
  find(id: string) {
    return this.env.DB.prepare('select * from users where id = ?').bind(id).first();
  }
}

@Module({ providers: [UsersService] })
class AppModule {}
export default createCloudflareWorker(AppModule);
```

`ENV` (`InjectionToken<VelaEnv>` from `@velajs/vela`) is the native environment; the Worker entry only exports. Type it with `wrangler types --include-runtime=false` (keep `@cloudflare/workers-types` for runtime types): include the generated `worker-configuration.d.ts` in tsconfig and regenerate it when the Wrangler file changes; `@velajs/cloudflare` extends `VelaEnv` with its `Cloudflare.Env`. Do not hand-write an `Env` interface or mint an environment `InjectionToken`. Inject `ENV` directly (`@InjectEnv()`, `inject: [ENV]`) or derive a narrower binding token with `defineProvider(TOKEN, { inject: [ENV], useFactory: env => env.DB })`. There is no environment parameter decorator; binding wrapper modules/services are not part of the API. Secrets in `ENV` drive framework features automatically: `URL_SIGNING_SECRET` (signed URLs and invocations) and `VELA_STUDIO_TOKEN` (Studio).

The worker exposes `fetch`, `queue`, and `scheduled`. Applications are cached by environment object identity; concurrent first events share bootstrap, different environments get separate applications, and failed bootstrap retries on the next event. For explicit construction use `createCloudflareApp(AppModule, { env })` or `cloudflareAdapter({ env })`; `adapters: RuntimeAdapter[]` on either entry composes further adapters. Bindings exist before DI factories run; binding I/O still belongs inside a platform event. An explicitly constructed app rejects events from another environment. Separate Workers sharing one repository type-check as separate programs, each with its own `wrangler types` output.

## Queue and cron handlers

Register `@Injectable()` providers with `@QueueConsumer('queue-name')`, and schedule work with core `@Cron(expression, { dialect: 'cloudflare' })`: a cron trigger runs every `@Cron` job whose expression is exactly the trigger string (declare the same string under Wrangler `triggers.crons`). There is no Cloudflare-only cron decorator. A job receives only its `ScheduleInvocation` (`expression`, `scheduledTime`, `signal`), as on Node; inject `CLOUDFLARE_SCHEDULED_EVENT` (request-scoped, from `@velajs/cloudflare`) for the trigger's bound `noRetry()`, and use `EXECUTION_LIFETIME.waitUntil()` for background work. Scheduled jobs run no guards/interceptors/filters; `ScheduleModule.forRoot({ dispatch: { kind: 'signed', target } })` re-enters a signed route with its global guards instead. The adapter warns once (throws in `diagnostics: 'throw'`) about a cron without a dialect whose weekday field has digits or whose day fields are both restricted, `dialect: 'unix'`, `timeZone: 'local'`, and `@Interval` jobs, which never run on Workers. Parse `MessageBatch<unknown>` bodies before reading application fields. Each queue dispatch uses a fresh scope and its declared guards/interceptors/filters; unhandled errors reach the platform for retry. These cold entrypoints receive the same native bindings as HTTP.

## Durable Objects and live queries

```ts
import { ENV, Module } from '@velajs/vela';
import { LiveModule } from '@velajs/vela/live';
import { CloudflareWebSocketModule, durableObjectCursorLog, durableObjectLive } from '@velajs/cloudflare';
import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';

// wrangler types declares ROOMS: DurableObjectNamespace<Room> on ENV.
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
export class Room extends VelaWebSocketDurableObject(RoomModule) {}
```

Import native classes only in Worker entry files. Use `CloudflareWebSocketModule`, never the core `WebSocketModule`, in a module a WebSocket Durable Object bootstraps: the Durable Object refuses to start with the core server. The Worker warns once when `LiveModule` keeps the default `localLive()` driver there, because its invalidations would never reach the Durable Object's subscriptions. Configure the namespace and `new_sqlite_classes` migration in Wrangler. Gateway options declare `path`, `roomParam`, `binding`, origins, and upgrade authentication. Core trusted identity, tenant, and expiry cross the upgrade boundary; caller-supplied identity headers are not authority. Driver/log factories return fresh state per application. Read `live-queries.md` for shared query schemas and delivery authorization.

## Storage, caches, and flags

R2 storage options contain actual bucket values (`disks: [{ disk: 'uploads', bucket: env.FILES }]`) and an explicit signing `secret`; resolve them with `StorageModule.forRootAsync({ inject: [ENV], useFactory: ... })`.

For response caching, use core `ResponseCacheModule` with `KVCacheStore` and optional `KVCacheInvalidationStore` in a separate non-expiring namespace. KV logical TTL is preserved in metadata; distributed invalidation remains eventually consistent.

Use `new KVCacheStore(env.CACHE)`, `kvFlagDriver(env.CACHE, options)`, and `flagshipFlagDriver(nativeBinding, options)`. Cache/object flag values remain unknown until parsed. There is no generic binding accessor that invents their value type.

The `@velajs/vela` root entry imports `hono/context-storage` (`node:async_hooks`) whether or not ambient access is used. `nodejs_compat` provides it and is default-on from compatibility date 2026-08-04; with an earlier date add `nodejs_als` (or `nodejs_compat`). Vela's Cloudflare and Durable Object transports need no other Node.js APIs; add `nodejs_compat` only for dependencies that import other `node:*` modules. Ambient container access is optional; per-request DI works without ambient state. On Workers stamp live commit headers explicitly instead of relying on ALS across DO RPC. See the Cloudflare package README and `apps/live-todo` for the complete deployed wiring.
