# @velajs/cloudflare

Nest-style modules, dependency injection, controllers, queue consumers, cron triggers,
and live WebSockets on Cloudflare Workers. HTTP routing uses Hono. Bindings use the
platform's native types.

## Native environment and application lifetime

The Worker's native environment is the framework `ENV` from `@velajs/vela`.
`createCloudflareWorker` seeds it for each environment before any provider is
constructed, so the Worker entry only exports. Inject it wherever bindings or
secrets are needed, including async provider factories (`inject: [ENV]`).

Types come from Wrangler. Run `wrangler types --include-runtime=false` (runtime
types stay with `@cloudflare/workers-types`) and include the generated
`worker-configuration.d.ts` in your tsconfig. It declares `Cloudflare.Env` from
the bindings and variables in your Wrangler file and the secret names in
`.dev.vars`; this package extends `VelaEnv` with it, so `ENV`, `{ create(env) }`
roots and `registerAs` factories are typed without a hand-written interface.
Regenerate it whenever the Wrangler file changes.

```ts
import { Controller, Get, InjectEnv, Module, type VelaEnv } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';

@Controller('/status')
class StatusController {
  // CACHE is a KVNamespace in worker-configuration.d.ts.
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  @Get()
  async status() {
    return { message: await this.env.CACHE.get('status') };
  }
}

@Module({ controllers: [StatusController] })
class AppModule {}

export default createCloudflareWorker(AppModule);
```

The worker exposes `fetch`, `queue`, and `scheduled`. Its first event builds an
application with that event's environment. Concurrent events for the same
environment object share construction. Different environment objects receive
separate applications, including separate providers, lifecycle state, and live
drivers. A failed construction is evicted and the next event retries.

When module configuration itself needs bindings, pass `{ create: (env) => AppModule }`
instead of a static class. Dynamic module roots and asynchronous factories are also
supported. The callback receives the native environment as `VelaEnv` and runs
once per environment object in an isolate. The same form
works with `VelaWebSocketDurableObject` for authenticated live gateways. The Worker
and every Durable Object instance built from the same environment share the
resulting module graph, including every value created inside `create(env)`:
`useValue` providers, module option objects and anything they reference are the
same objects in all of those applications. Only class and factory providers and
lifecycle state are built per application. A rejected factory or failed bootstrap
is evicted, so the next event runs the factory again. Build per-application state
in factories: `useFactory` providers, `forRootAsync`, or driver factories such as
`driver: () => inline()` for an in-process queue driver. See the
[complete API starter](../../apps/api-starter/README.md) for D1, Better Auth, CRUD,
the generated Hono client, live updates, and Studio inspection in one application.

The application cache uses weak object keys, so the cache itself does not keep a
replaced environment alive. Module metadata does: classes declared while a root
resolves stay registered for the life of the isolate, together with the values
their module options capture. Build secret-bearing values in `forRootAsync`
factories that inject `ENV` rather than capturing them in module options.
Providers with request scope still rebuild per HTTP request or queue/cron dispatch.
Do not retain request objects or authentication state in singleton providers.

For explicit construction inside a platform event:

```ts
const app = await createCloudflareApp(AppModule, {
  env,
  globalPrefix: '/api',
  middleware: (bindings) => [async (context, next) => {
    context.header('x-service', bindings.SERVICE_NAME);
    await next();
  }],
});
const bindings = app.get(ENV); // VelaEnv
return app.fetch(request, env, executionContext);
```

`env` is registered as `ENV` before provider factories and lifecycle hooks.
Bindings inside `middleware(env)` are typed as `VelaEnv` too; request callbacks
capture the native environment without retyping Hono's context. Referencing a
binding is safe during construction; platform I/O must still happen inside a
Workers event or Durable Object context. An explicitly built application rejects
requests or events carrying another environment object, including calls through
the underlying Hono app. Internal `ctx.run` reentry retains the application's
environment.

`cloudflareAdapter({ env })` provides the same bootstrap and request contract
when composing `VelaFactory.create` directly. `createCloudflareWorker` and
`createCloudflareApp` accept `adapters: RuntimeAdapter[]`, composed after the
Cloudflare adapter for each application, so the Worker entry needs no
hand-written per-environment cache for them.

Because `ENV` carries every binding, variable and secret, framework features
read their secrets from it without extra wiring: a string `URL_SIGNING_SECRET`
signs URLs and invocations when no explicit secret is configured, and Studio
reads `VELA_STUDIO_TOKEN` and its `VELA_STUDIO_*_EDITABLE` flags. Set them with
`wrangler secret put`. Values come from outside the program, so validate each
value your own code reads before relying on it.

## Module-based queues, cron and RPC

Import `QueueModule` and configure `cloudflareQueueDriver` consumer mappings to
connect native batches directly to `@Processor`/`@Process` providers. Use
`ScheduleModule.forRoot()` and `@Cron()` for native scheduled work. The
[module guide](../../docs/module-workers.md) covers producer-only and consumer-only
Workers, RPC modules, migration, and deployment checks. Native decorators remain
available as escape hatches.

## Managed queue and cron work

Each matching queue/cron handler receives its original event and environment,
plus a context whose `waitUntil(promise)` delegates to the platform and retains
that handler's DI scope until the promise settles. Class/method guards,
interceptors and filters resolve asynchronously from the handler's declaring
module. The execution context exposes that same child via `getContainer()` and
its owner via `getModuleId()`; `REQUEST_CONTEXT` remains HTTP-only.

Inject `EXECUTION_LIFETIME` from `@velajs/vela` to schedule deferred callbacks
with `lifetime.defer(work)` or register already-started work with
`lifetime.waitUntil(promise)`. The handler, managed work and asynchronous provider
disposal finish before queue/cron dispatch returns. Unclaimed failures reject
for the platform to observe; they are not silently converted into success. When
several handlers match, every handler settles before a single failure or
`AggregateError` is returned. Background failure does not undo completed writes;
handlers still need the idempotency appropriate to their delivery semantics.

See [execution scopes](../../docs/execution-scopes.md) for lifetime ownership,
stream boundaries, cancellation and optional transport integration.

## Typed provider factories

Bindings retain their full native API and generic parameters. There are no
binding-name wrappers to initialize or cast.

```ts
import { defineProvider, ENV, InjectionToken, Module } from '@velajs/vela';

const TASK_QUEUE = new InjectionToken<Queue<{ taskId: string }>>('task queue');

@Module({
  providers: [defineProvider(TASK_QUEUE, {
    inject: [ENV],
    useFactory: (env) => env.JOBS,
  })],
  exports: [TASK_QUEUE],
})
class JobsModule {}
```

Every `useFactory` strategy declares its dependencies with `inject`, including
`inject: []` for factories without dependencies. This also applies to
`lazyProvider` and `forRootAsync` factory options.

Use native `env.DB`, `env.CACHE`, `env.FILES`, `env.JOBS`, `env.AI`,
`env.VECTORIZE`, or `env.HYPERDRIVE` directly. Inject `ENV` in constructors
(`@InjectEnv()`) and factories (`inject: [ENV]`); it works the same in HTTP,
queue, cron and Durable Object code.

## Queues and cron

```ts
import { InjectEnv, Injectable, type VelaEnv } from '@velajs/vela';
import { QueueConsumer, Scheduled } from '@velajs/cloudflare';

@Injectable()
class Jobs {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  @Scheduled('0 * * * *')
  async refresh() {
    await this.env.CACHE.put('last-refresh', new Date().toISOString());
  }

  @QueueConsumer('jobs')
  async consume(batch: MessageBatch<unknown>) {
    for (const message of batch.messages) {
      // Validate message.body before interpreting its application shape.
    }
  }
}
```

Core `@Cron()` also runs on Workers scheduled triggers. Consumers use fresh
request scopes and their declared guards, interceptors, and filters. Unclaimed
errors propagate to the platform for retry. Cold queue and cron events have the
same native bindings and live invalidation capabilities as HTTP.

## WebSockets, live queries, and Durable Objects

Use the native Durable Object entrypoint only in your Worker entry file:

```ts
import { ENV, Module } from '@velajs/vela';
import { LiveModule } from '@velajs/vela/live';
import {
  CloudflareWebSocketModule,
  createCloudflareWorker,
  durableObjectCursorLog,
  durableObjectLive,
} from '@velajs/cloudflare';
import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';

@Module({
  imports: [
    CloudflareWebSocketModule.forRoot(),
    LiveModule.forRootAsync({
      // ROOMS is typed DurableObjectNamespace<Room> by `wrangler types`.
      inject: [ENV],
      useFactory: (env) => ({
        driver: () => durableObjectLive({
          namespace: env.ROOMS,
          gatewayPath: '/rooms/:room/ws',
        }),
        log: () => durableObjectCursorLog(),
      }),
    }),
  ],
  // Add your @WebSocketGateway and @LiveResolver classes here.
  providers: [],
})
class RoomModule {}

export class Room extends VelaWebSocketDurableObject(RoomModule) {}
export default createCloudflareWorker(RoomModule);
```

Declare gateways with `@WebSocketGateway({ path, roomParam, binding, ... })` and
configure origins and upgrade authentication for your application. Upgrade
routing consumes the core trusted request identity, checks conflicts with the
upgrade credential, and forwards issuer, subject, tenant, and expiry to the DO.
Client-supplied internal identity headers are stripped before authorization.

Declare live query argument and result schemas once with `defineLiveQuery({ args,
result })` from `@velajs/vela/live`. Both entries accept a parser object such as a
Zod schema. Use `@LiveQuery('todos.list', definition, { tags: ['todos'] })` on the
resolver and share the definition with its client. Restored hibernation arguments
and final query results use the same validation boundary.

Each application constructs its own driver and cursor log. Workers send
invalidations through the typed DO namespace; the DO uses its own live engine
and SQLite cursor log. Configure the class in Wrangler `new_sqlite_classes` to
retain cursor/epoch state across hibernation. Hibernated subscriptions are
restored on wake; the shared live protocol handles resume or snapshot fallback.

The DO class preserves its RPC types, so `DurableObjectNamespace<Room>` exposes
`invalidate`, `broadcast`, and PITR methods without assertions. `broadcastToRoom`,
`liveInvalidateToRoom`, and the PITR helpers remain available from the root
package. `VelaNonceDurableObject` is exported from `/durable-objects`; its
`durableObjectNonceStore` factory remains on the root entrypoint.

The root package contains no runtime `cloudflare:workers` import and can be
loaded by Node tooling. Native classes belong to `/durable-objects`.

## R2 storage and caches

For new object/file storage, prefer the independently imported
[`@velajs/storage`](../storage/README.md#portable-storage-and-the-cloudflare-proxy)
with a native R2 or hybrid driver. The storage module below remains the supported
1.x Worker HMAC proxy API; its signed routes differ from provider-signed URLs.

Configure named disks from an async factory using actual bucket values:

```ts
StorageModule.forRootAsync({
  inject: [ENV],
  useFactory: (env) => ({
    defaultDisk: 'uploads',
    secret: env.APP_SECRET,
    disks: [{ disk: 'uploads', bucket: env.FILES, root: 'uploads/{year}' }],
    presignedUrl: { defaultExpiry: 3600, maxExpiry: 86400 },
  }),
});
```

`StorageService` supports upload, download, delete, existence checks, and expiring
signed download URLs. The proxy validates signatures, HTTP method, expiry, and
the configured root; returned files download as attachments.

Construct `KVCacheStore` and `KvFlagDriver` with a native namespace:
`new KVCacheStore(env.CACHE)` and `new KvFlagDriver(env.CACHE)`. Cache reads and
object-valued flag reads return `unknown`; validate them with an application
parser. Core `CacheService.getParsed(key, parser)` infers the result from that
parser. Memory and tiered cache reads use the same unknown-value contract.

## Development

From the repository root:

```sh
pnpm --filter @velajs/cloudflare test
pnpm --filter @velajs/cloudflare test:workers
pnpm --filter @velajs/cloudflare typecheck
```

The Workers suite uses real KV, D1, R2, WebSockets, SQLite Durable Objects, and
cold event dispatch. See the [security guide](https://github.com/velajs/vela/blob/main/docs/cloudflare-security.md) for trusted identity,
URL signing, and WebSocket boundaries.

### Asynchronous response caches

`KVCacheStore` works directly in core `ResponseCacheModule` or as a tier beneath
`TieredCacheStore`. The adapter retains absolute logical expiry in KV metadata;
KV's minimum physical retention does not extend the requested TTL. For optional
generic tags/scoped invalidation, configure `KVCacheInvalidationStore` with a
separate dedicated KV namespace without TTLs or lifecycle cleanup. It is eventually
consistent, including concurrent writes and cached negative reads, and does not
promise globally strong invalidation. Construct both in an environment-injected
factory. See the [caching guide](../../docs/caching.md).
