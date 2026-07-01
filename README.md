# @velajs/cloudflare

[![npm version](https://img.shields.io/npm/v/@velajs/cloudflare)](https://www.npmjs.com/package/@velajs/cloudflare)
[![CI](https://github.com/velajs/cloudflare/actions/workflows/ci.yml/badge.svg)](https://github.com/velajs/cloudflare/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@velajs/cloudflare)](https://github.com/velajs/cloudflare/blob/main/LICENSE)

Cloudflare Workers integration for the [Vela](https://github.com/velajs/vela) framework. NestJS-style per-service modules for KV, D1, R2, Queues, Durable Objects, Workers AI, Vectorize, and Hyperdrive.

## Install

```bash
pnpm add @velajs/cloudflare @velajs/vela hono
pnpm add -D @cloudflare/workers-types
```

`@cloudflare/workers-types` is a required peer (types-only — zero runtime cost). It's what gives `KVNamespace`, `D1Database`, `R2Bucket`, `Queue`, `DurableObjectNamespace`, `Ai`, `VectorizeIndex`, and `Hyperdrive` their proper types when you reach into the underlying binding.

## Service shape

Every service is a thin typed wrapper around its Cloudflare binding. Use the accessor (`.namespace`, `.database`, `.bucket`, `.queue`, `.binding`, `.index`) to call the binding's methods directly — full `@cloudflare/workers-types` autocomplete, no shim layer in between.

```ts
class KVService { readonly namespace: KVNamespace; }
class D1Service { readonly database: D1Database; }
class R2Service { readonly bucket: R2Bucket; }
class QueueService<T> { readonly queue: Queue<T>; }
class DurableObjectService { readonly namespace: DurableObjectNamespace; }
class AIService { readonly binding: Ai; }
class VectorizeService { readonly index: VectorizeIndex; }
class HyperdriveService { readonly binding: Hyperdrive; }
```

## Quick Start

```ts
import { Controller, Get, Module, Injectable, Param } from '@velajs/vela';
import { createCloudflareApp, KVModule, KVService, D1Module, D1Service } from '@velajs/cloudflare';

@Injectable()
class UserService {
  constructor(
    private kv: KVService,
    private d1: D1Service,
  ) {}

  async findById(id: string) {
    const cached = await this.kv.namespace.get(`user:${id}`);
    if (cached) return JSON.parse(cached as string);

    const user = await this.d1.database.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (user) await this.kv.namespace.put(`user:${id}`, JSON.stringify(user));
    return user;
  }
}

@Controller('/users')
class UserController {
  constructor(private users: UserService) {}

  @Get('/:id')
  async getUser(@Param('id') id: string) {
    return this.users.findById(id);
  }
}

@Module({
  imports: [
    KVModule.forRoot({ binding: 'CACHE' }),
    D1Module.forRoot({ binding: 'DB' }),
  ],
  providers: [UserService],
  controllers: [UserController],
})
class AppModule {}

export default await createCloudflareApp(AppModule);
```

The `binding` string matches the binding name in your `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "abc123"

[[d1_databases]]
binding = "DB"
database_id = "def456"
```

## Modules

Each module follows the same pattern: `XModule.forRoot({ binding: 'NAME' })` returns a dynamic module that provides a service wrapping the Cloudflare binding.

| Module | Service | Cloudflare Binding |
|--------|---------|-------------------|
| `KVModule` | `KVService` | KV Namespace |
| `D1Module` | `D1Service` | D1 Database |
| `R2Module` | `R2Service` | R2 Bucket |
| `QueueModule` | `QueueService` | Queue (producer) |
| `DurableObjectModule` | `DurableObjectService` | Durable Object Namespace |
| `AIModule` | `AIService` | Workers AI |
| `VectorizeModule` | `VectorizeService` | Vectorize Index |
| `HyperdriveModule` | `HyperdriveService` | Hyperdrive |

### KVModule

```ts
import { KVModule, KVService } from '@velajs/cloudflare';

@Module({ imports: [KVModule.forRoot({ binding: 'MY_KV' })] })
class AppModule {}

@Injectable()
class CacheService {
  constructor(private kv: KVService) {}

  async get(key: string) { return this.kv.namespace.get(key); }
  async set(key: string, value: string) { return this.kv.namespace.put(key, value); }
  async remove(key: string) { return this.kv.namespace.delete(key); }
  async keys() { return this.kv.namespace.list(); }
}
```

### D1Module

```ts
import { D1Module, D1Service } from '@velajs/cloudflare';

@Module({ imports: [D1Module.forRoot({ binding: 'DB' })] })
class AppModule {}

@Injectable()
class PostService {
  constructor(private d1: D1Service) {}

  async findAll() {
    return this.d1.database.prepare('SELECT * FROM posts').all();
  }

  async create(title: string) {
    return this.d1.database.prepare('INSERT INTO posts (title) VALUES (?)').bind(title).run();
  }
}
```

### R2Module

```ts
import { R2Module, R2Service } from '@velajs/cloudflare';

@Module({ imports: [R2Module.forRoot({ binding: 'ASSETS' })] })
class AppModule {}

@Injectable()
class StorageService {
  constructor(private r2: R2Service) {}

  async upload(key: string, data: string) { return this.r2.bucket.put(key, data); }
  async download(key: string) { return this.r2.bucket.get(key); }
  async remove(key: string) { return this.r2.bucket.delete(key); }
}
```

### QueueModule

```ts
import { QueueModule, QueueService } from '@velajs/cloudflare';

@Module({ imports: [QueueModule.forRoot({ binding: 'EMAIL_QUEUE' })] })
class AppModule {}

@Injectable()
class NotificationService {
  constructor(private queue: QueueService) {}

  async sendEmail(to: string, subject: string) {
    await this.queue.queue.send({ to, subject });
  }
}
```

### DurableObjectModule

```ts
import { DurableObjectModule, DurableObjectService } from '@velajs/cloudflare';

@Module({ imports: [DurableObjectModule.forRoot({ binding: 'COUNTER' })] })
class AppModule {}

@Injectable()
class CounterService {
  constructor(private doNs: DurableObjectService) {}

  async increment(name: string) {
    const id = this.doNs.namespace.idFromName(name);
    const stub = this.doNs.namespace.get(id);
    return (stub as any).fetch('/increment');
  }
}
```

### AIModule

```ts
import { AIModule, AIService } from '@velajs/cloudflare';

@Module({ imports: [AIModule.forRoot({ binding: 'AI' })] })
class AppModule {}

@Injectable()
class ChatService {
  constructor(private ai: AIService) {}

  async chat(prompt: string) {
    return this.ai.binding.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'user', content: prompt }],
    });
  }
}
```

### VectorizeModule

```ts
import { VectorizeModule, VectorizeService } from '@velajs/cloudflare';

@Module({ imports: [VectorizeModule.forRoot({ binding: 'EMBEDDINGS' })] })
class AppModule {}

@Injectable()
class SearchService {
  constructor(private vectorize: VectorizeService) {}

  async search(vector: number[]) {
    return this.vectorize.index.query(vector, { topK: 10 });
  }

  async addVectors(vectors: unknown[]) {
    return this.vectorize.index.upsert(vectors);
  }
}
```

### HyperdriveModule

```ts
import { HyperdriveModule, HyperdriveService } from '@velajs/cloudflare';

@Module({ imports: [HyperdriveModule.forRoot({ binding: 'POSTGRES' })] })
class AppModule {}

@Injectable()
class DbService {
  constructor(private hd: HyperdriveService) {}

  getConnectionString() {
    return this.hd.binding.connectionString;
  }

  getConfig() {
    return { host: this.hd.binding.host, port: this.hd.binding.port, database: this.hd.binding.database };
  }
}
```

## Decorators

### @Env()

Parameter decorator for direct access to Cloudflare bindings in controllers. Useful as an escape hatch when you don't need a full module.

```ts
import { Env } from '@velajs/cloudflare';

@Controller('/debug')
class DebugController {
  @Get('/env')
  handle(@Env() env: Record<string, unknown>) {
    return { bindings: Object.keys(env) };
  }

  @Get('/kv')
  handleKV(@Env('MY_KV') kv: KVNamespace) {
    return kv.get('some-key');
  }
}
```

### @Scheduled()

Method decorator for cron trigger handlers.

```ts
import { Scheduled } from '@velajs/cloudflare';

@Injectable()
class CleanupService {
  @Scheduled('0 * * * *')  // every hour
  async hourlyCleanup() {
    console.log('Running hourly cleanup');
  }

  @Scheduled('0 0 * * *')  // every day at midnight
  async dailyReport() {
    console.log('Generating daily report');
  }
}
```

### @QueueConsumer()

Method decorator for queue consumer handlers.

```ts
import { QueueConsumer } from '@velajs/cloudflare';

@Injectable()
class EmailWorker {
  @QueueConsumer('email-queue')
  async process(batch: MessageBatch) {
    for (const msg of batch.messages) {
      console.log('Sending email:', msg.body);
      msg.ack();
    }
  }
}
```

## createCloudflareApp

Use `createCloudflareApp()` instead of `VelaFactory.create()` for Cloudflare apps. It sets up a one-time middleware that captures `c.env` on the first request and initializes all binding modules.

```ts
import { createCloudflareApp } from '@velajs/cloudflare';

const app = await createCloudflareApp(AppModule);
export default app;
```

## Full Worker Export

To use scheduled triggers and queue consumers, export the handlers explicitly:

```ts
const app = await createCloudflareApp(AppModule);

export default {
  fetch: app.fetch,
  scheduled: app.scheduled.bind(app),
  queue: app.queue.bind(app),
};
```

## Raw Binding Access

Each service exposes the underlying Cloudflare binding via a getter:

```ts
const rawKV = kvService.namespace;     // KVNamespace
const rawD1 = d1Service.database;      // D1Database
const rawR2 = r2Service.bucket;        // R2Bucket
const rawQueue = queueService.queue;   // Queue
const rawDO = doService.namespace;     // DurableObjectNamespace
const rawAI = aiService.binding;       // Ai
const rawVec = vecService.index;       // VectorizeIndex
const rawHD = hdService.binding;       // Hyperdrive
```

## How It Works

Cloudflare Workers only provide bindings (`env.DB`, `env.MY_KV`, etc.) at request time via the `env` parameter. They are stable across requests within an isolate.

`createCloudflareApp` handles this by:

1. Each `XModule.forRoot()` creates a `BindingRef` (mutable holder) and registers it in the DI container
2. Services are constructed at boot time with the `BindingRef` — no binding access yet
3. On the first HTTP request, a one-time middleware reads `c.env` and initializes all `BindingRef` instances
4. From that point on, services access bindings lazily through the ref

This means binding-dependent services work as plain singletons with no per-request overhead.

## License

MIT
