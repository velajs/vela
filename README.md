# @velajs/cloudflare

Cloudflare Workers integration for the [Vela](https://github.com/velajs/vela) framework. NestJS-style per-service modules for KV, D1, R2, and Queues.

## Install

```bash
bun add @velajs/cloudflare @velajs/vela hono
```

## Quick Start

```ts
import { Controller, Get, Module, Injectable, Param } from '@velajs/vela';
import { CloudflareFactory, KVModule, D1Module } from '@velajs/cloudflare';
import type { KVService, D1Service } from '@velajs/cloudflare';

@Injectable()
class UserService {
  constructor(
    private kv: KVService,
    private d1: D1Service,
  ) {}

  async findById(id: string) {
    const cached = await this.kv.get(`user:${id}`);
    if (cached) return JSON.parse(cached as string);

    const user = await this.d1.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (user) await this.kv.put(`user:${id}`, JSON.stringify(user));
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

export default await CloudflareFactory.create(AppModule);
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

### KVModule

```ts
import { KVModule } from '@velajs/cloudflare';
import type { KVService } from '@velajs/cloudflare';

@Module({ imports: [KVModule.forRoot({ binding: 'MY_KV' })] })
class AppModule {}

@Injectable()
class CacheService {
  constructor(private kv: KVService) {}

  async get(key: string) { return this.kv.get(key); }
  async set(key: string, value: string) { return this.kv.put(key, value); }
  async remove(key: string) { return this.kv.delete(key); }
  async keys() { return this.kv.list(); }
}
```

### D1Module

```ts
import { D1Module } from '@velajs/cloudflare';
import type { D1Service } from '@velajs/cloudflare';

@Module({ imports: [D1Module.forRoot({ binding: 'DB' })] })
class AppModule {}

@Injectable()
class PostService {
  constructor(private d1: D1Service) {}

  async findAll() {
    return this.d1.prepare('SELECT * FROM posts').all();
  }

  async create(title: string) {
    return this.d1.prepare('INSERT INTO posts (title) VALUES (?)').bind(title).run();
  }
}
```

### R2Module

```ts
import { R2Module } from '@velajs/cloudflare';
import type { R2Service } from '@velajs/cloudflare';

@Module({ imports: [R2Module.forRoot({ binding: 'ASSETS' })] })
class AppModule {}

@Injectable()
class StorageService {
  constructor(private r2: R2Service) {}

  async upload(key: string, data: string) { return this.r2.put(key, data); }
  async download(key: string) { return this.r2.get(key); }
  async remove(key: string) { return this.r2.delete(key); }
}
```

### QueueModule

```ts
import { QueueModule } from '@velajs/cloudflare';
import type { QueueService } from '@velajs/cloudflare';

@Module({ imports: [QueueModule.forRoot({ binding: 'EMAIL_QUEUE' })] })
class AppModule {}

@Injectable()
class NotificationService {
  constructor(private queue: QueueService) {}

  async sendEmail(to: string, subject: string) {
    await this.queue.send({ to, subject });
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

## CloudflareFactory

Use `CloudflareFactory.create()` instead of `VelaFactory.create()` for Cloudflare apps. It sets up a one-time middleware that captures `c.env` on the first request and initializes all binding modules.

```ts
import { CloudflareFactory } from '@velajs/cloudflare';

const app = await CloudflareFactory.create(AppModule);
export default app;
```

## Full Worker Export

To use scheduled triggers and queue consumers, export the handlers explicitly:

```ts
const app = await CloudflareFactory.create(AppModule);

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
```

## How It Works

Cloudflare Workers only provide bindings (`env.DB`, `env.MY_KV`, etc.) at request time via the `env` parameter. They are stable across requests within an isolate.

`CloudflareFactory` handles this by:

1. Each `XModule.forRoot()` creates a `BindingRef` (mutable holder) and registers it in the DI container
2. Services are constructed at boot time with the `BindingRef` — no binding access yet
3. On the first HTTP request, a one-time middleware reads `c.env` and initializes all `BindingRef` instances
4. From that point on, services access bindings lazily through the ref

This means binding-dependent services work as plain singletons with no per-request overhead.

## License

MIT
