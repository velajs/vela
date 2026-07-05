# Cloudflare (`@velajs/cloudflare`)

The Cloudflare Workers adapter: run a Vela app on Workers with typed bindings (KV/D1/R2/Queues/DO/AI/Vectorize/Hyperdrive), `@Scheduled`/`@QueueConsumer` entrypoints, Durable-Object WebSocket hibernation, and CF-backed feature-flag drivers. Single export `.`. Peers: `@cloudflare/workers-types`, `@velajs/vela`, `hono` (and `@velajs/feature-flags`, optional).

## Bootstrapping

```ts
import { createCloudflareApp } from '@velajs/cloudflare';
import { AppModule } from './app.module';

const app = await createCloudflareApp(AppModule);   // options?: { globalPrefix?, middleware? }

export default {
  fetch: app.fetch,
  scheduled: app.scheduled.bind(app),   // only if you use @Scheduled / @Cron
  queue: app.queue.bind(app),           // only if you use @QueueConsumer
};
```

`createCloudflareApp(rootModule, options?)` is `VelaFactory.create` with `adapters: [cloudflareAdapter()]` prewired. If you build the app yourself, add the adapter explicitly: `VelaFactory.create(AppModule, { adapters: [cloudflareAdapter()] })`. The returned `CloudflareApplication` adds `scheduled(event, env, ctx)` and `queue(batch, env, ctx)` to the usual `fetch` / `getHonoApp()` / `get(token)` / `mountOpenApi(options)` / `close()` surface.

## Bindings — per-binding modules

Each Cloudflare binding gets a module whose only option is the wrangler `binding` name; import the module, inject its service:

```ts
import { KVModule, KVService, D1Module, D1Service } from '@velajs/cloudflare';

@Module({ imports: [KVModule.forRoot({ binding: 'CACHE' }), D1Module.forRoot({ binding: 'DB' })] })
class AppModule {}

@Injectable()
class UsersService {
  constructor(private readonly kv: KVService, private readonly d1: D1Service) {}
  async get(id: string) { return this.d1.database.prepare('select * from users where id=?').bind(id).first(); }
}
```

| Module | `.forRoot` | Service (accessor) |
|---|---|---|
| `KVModule` | `{ binding }` | `KVService` → `.namespace: KVNamespace` |
| `D1Module` | `{ binding }` | `D1Service` → `.database: D1Database` |
| `R2Module` | `{ binding }` | `R2Service` → `.bucket: R2Bucket` |
| `QueueModule` | `{ binding }` | `QueueService` → `.queue: Queue` (producer) |
| `DurableObjectModule` | `{ binding }` | `DurableObjectService` → `.namespace: DurableObjectNamespace` |
| `AIModule` | `{ binding }` | `AIService` → `.binding: Ai` |
| `VectorizeModule` | `{ binding }` | `VectorizeService` → `.index: VectorizeIndex` |
| `HyperdriveModule` | `{ binding }` | `HyperdriveService` → `.binding` + `.connectionString`/`.host`/… |
| `EnvModule` | `()` (global, no options) | `EnvService` → `.env`, `.get(key)` |

These modules expose **only `forRoot`** (no `forRootAsync`). Bindings resolve lazily from the request `env` the adapter captures — reads throw until the first request initializes them. `EnvService` is the wildcard for reading arbitrary vars (and for feeding `forRootAsync` factories of other modules). Note: `@velajs/cloudflare`'s `QueueModule` is the Cloudflare Queues **producer** binding — distinct from `@velajs/vela/queue`'s in-core job `QueueModule`.

## Scheduled tasks & queue consumers

Declare handlers as methods on `@Injectable()` providers:

```ts
import { Scheduled, QueueConsumer } from '@velajs/cloudflare';

@Injectable()
class Workers {
  @Scheduled('0 * * * *')
  async hourly() { /* cron tick */ }

  @QueueConsumer('email-queue')
  async onEmail(batch: MessageBatch) { for (const m of batch.messages) m.ack(); }
}
```

`@Scheduled(cron)` and `@QueueConsumer(queueName)` register `cf:scheduled` / `cf:queue` entrypoints. `app.scheduled()` fires matching `@Scheduled` handlers (and vela's own `@Cron`) by cron; `app.queue()` dispatches a batch by queue name. Both run in a fresh request scope through the shared `PipelineRunner`: **handler-scoped** guards/interceptors/filters apply; app-wide HTTP `APP_*` components do not (parity with the queue dispatcher — see `references/queues.md`).

## WebSocket over Durable Objects (hibernation)

The same gateway code as `references/websocket.md`; on Cloudflare the socket lives in a Durable Object with hibernation:

```ts
import { CloudflareWebSocketModule, VelaWebSocketDurableObject, WebSocketGateway, SubscribeMessage } from '@velajs/cloudflare';

@WebSocketGateway({ path: '/rooms/:id/ws', binding: 'CHAT_ROOM' })
class ChatGateway {
  @SubscribeMessage('message') onMessage(/* … */) {}
}

@Module({ imports: [CloudflareWebSocketModule.forRoot()], providers: [ChatGateway] })
class AppModule {}

// The DO class — its name must match the wrangler `class_name`.
export class ChatRoom extends VelaWebSocketDurableObject(AppModule) {}
```

`CloudflareWebSocketModule.forRoot()` replaces the core `WebSocketModule.forRoot()` (it provides the CF `WsServer`). `VelaWebSocketDurableObject(rootModule)` is a **factory** returning a `DurableObject` class that owns the `WebSocketPair`/101 upgrade and the hibernation `webSocketMessage/Close/Error` handlers. Push from outside a socket with `broadcastToRoom(namespace, room, event, data?)`. The gateway decorators are re-exported from `@velajs/vela/websocket`, so you import everything from `@velajs/cloudflare`.

## Feature-flag drivers

`@velajs/cloudflare` ships two `FeatureFlagDriver`s (see `references/feature-flags.md`) — wire them through `FeatureFlagsModule.forRootAsync`:

```ts
import { flagshipFlagDriver, kvFlagDriver, EnvService, KVService } from '@velajs/cloudflare';
import { FeatureFlagsModule } from '@velajs/feature-flags';

FeatureFlagsModule.forRootAsync({
  inject: [EnvService, KVService],
  useFactory: (env: EnvService, kv: KVService) => ({
    drivers: [
      flagshipFlagDriver(() => env.get('FLAGS')!),   // Cloudflare Flagship binding (lazy accessor)
      kvFlagDriver(kv, { prefix: 'flag:' }),          // KV-backed JSON flags
    ],
  }),
});
```

`flagshipFlagDriver(binding | () => binding, { name? })` maps onto a Flagship binding; `kvFlagDriver(kv: KVService, { name?, prefix? })` reads JSON values from KV. Both return the caller's fallback on a miss.

## wrangler notes

Declare bindings in `wrangler.toml`/`.jsonc` under their names, and set compatibility flags where needed:

- **Durable-Object WebSockets** need `compatibility_flags = ["nodejs_compat"]` plus the DO binding + a `new_sqlite_classes` migration for the hibernation DO.
- **Ambient container / ALS** (`ambientContainer: true`, `getCurrentContainer()`) needs `nodejs_als` (or `nodejs_compat`). It is off by default — the per-request child container is the default DI path.

(`@velajs/cloudflare` also ships its own R2-backed `StorageModule`/`StorageService`/`R2StorageDriver`, configured via `.register({ disks, defaultDisk, presignedUrl? })` — distinct from the standalone `@velajs/storage` package in `references/storage.md`.)
