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

## Workflows

Durable [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) over [`@velajs/workflow`](https://www.npmjs.com/package/@velajs/workflow)'s neutral core. Declare each workflow **once** as a `defineWorkflow` export and consume it twice from that one source — on the `AppModule` (for `ctx.workflows` + entrypoint discovery) and in the Worker entry (for the platform class).

```ts
// workflows.ts
import { defineWorkflow } from '@velajs/cloudflare';

export const orderPipeline = defineWorkflow<{ orderId: string }>({
  handler: async (ctx) => {
    const order = await ctx.step.do('fetch-order', () =>
      // ctx.run re-enters a signed app route across isolates (see below).
      ctx.run({ route: 'orders.get' }, { body: { id: ctx.params.orderId } }),
    );
    await ctx.step.sleep('settle', '1 minute');
    return order;
  },
});
```

```ts
// app.module.ts
import { Module } from '@velajs/vela';
import { WorkflowModule } from '@velajs/cloudflare';
import * as workflows from './workflows';

@Module({ imports: [WorkflowModule.forRoot({ workflows })] })
export class AppModule {}
```

```ts
// worker.ts — the exported class const name MUST equal the wrangler class_name.
import { createCloudflareApp, createWorkflowEntrypoints } from '@velajs/cloudflare';
import * as workflows from './workflows';
import { AppModule } from './app.module';

const app = await createCloudflareApp(AppModule);
export default { fetch: app.fetch };

export const { OrderPipelineWorkflow } = createWorkflowEntrypoints(workflows, {
  rootModule: AppModule,
});
```

### `ctx.run` (cross-isolate re-entry)

A `WorkflowEntrypoint` runs in its own isolate with no HTTP server, so `ctx.run` crosses back to the main Worker (where the routes live) over a **self-service binding** and re-enters a `@SignedInvocation()` route. The signed token is verified byte-identically to the in-isolate path — only the network hop differs. A deterministic `4xx` response is re-thrown as the native `NonRetryableError` (the input will never succeed on retry); a `5xx` propagates as a retryable error.

### wrangler configuration

Names are derived purely from the **export name**, so wrangler config, the generated class const, and the entrypoint registry always agree. For `export const orderPipeline = defineWorkflow(...)`:

```jsonc
{
  "workflows": [
    {
      "name": "order-pipeline",              // definition.name ?? kebab(exportName)
      "binding": "WORKFLOW_ORDER_PIPELINE",  // WORKFLOW_ + SCREAMING_SNAKE(exportName)
      "class_name": "OrderPipelineWorkflow", // Pascal(exportName) + "Workflow"
    },
  ],
  // A self-reference so ctx.run can re-enter the main Worker's routes.
  "services": [{ "binding": "SELF", "service": "<this-worker>" }],
}
```

`URL_SIGNING_SECRET` (or `INVOCATION_SIGNING_SECRET`) **must** be a Workers secret (`wrangler secret put …` / `.dev.vars`) so both isolates resolve the same key. Override the re-entry binding with `createWorkflowEntrypoints(workflows, { rootModule, serviceBinding: 'MY_SELF' })`.

Every declared workflow is discoverable through `app.entrypoints.ofKind('cf:workflow')` for CLI / OpenAPI / introspection.

## Email

Send and receive email over [`@velajs/mail`](https://www.npmjs.com/package/@velajs/mail)'s edge-neutral core. `@velajs/mail` owns the send pipeline (render → validate → build → dispatch), every address / header-injection guard, and the inbound verdict gate; this package supplies two Cloudflare adapters — an **outbound** transport over the `send_email` binding and an **inbound** `email()` host hook — and re-exports the inbound authoring surface (`OnInboundEmail`, `InboundEmail`, `MailInboundGate`).

### Outbound (`send_email` binding)

`CloudflareEmailModule.forRoot()` provides `@velajs/mail`'s `MAIL_TRANSPORT` **globally**, so a `MailModule.forRoot({ from })` in any module resolves it — import the email module first and pass no explicit `transport`:

```ts
import { Module } from '@velajs/vela';
import { CloudflareEmailModule } from '@velajs/cloudflare';
import { MailModule, MailService } from '@velajs/mail';

@Module({
  imports: [
    CloudflareEmailModule.forRoot(), // provides MAIL_TRANSPORT (binding: 'SEND_EMAIL')
    MailModule.forRoot({ from: 'no-reply@example.com' }),
  ],
})
export class AppModule {}

// Inject MailService anywhere and send — guards run in @velajs/mail's buildMessage
// ABOVE the transport, so a malicious subject/address never reaches the binding:
class Notifier {
  constructor(private readonly mail: MailService) {}
  notify() {
    return this.mail.send({ to: 'user@example.com', subject: 'Hi', text: 'Hello' });
  }
}
```

The transport assembles the RFC 822 message with `renderRawMessage` above the seam and constructs one `EmailMessage` per envelope recipient (`cloudflare:email` is single-recipient, so multi-recipient sends fan out). Provider errors are redacted — a failed `send()` throws a fixed `MailError('provider_error', …, { internal: true })`; the raw platform error rides `MailError.cause` for server-side logging only. Override the binding name with `CloudflareEmailModule.forRoot({ binding: 'MY_SEND_EMAIL' })`.

### Inbound (`email()` host hook)

Declare handlers with `@OnInboundEmail` and export `email` from the Worker. The hook reads the **raw byte stream** (not `message.headers`, which collapses duplicate `Authentication-Results` and would let an attacker-injected lower header win) and hands a parsed `InboundEmail` to `@velajs/mail`'s CF-free dispatcher:

```ts
import { Injectable } from '@velajs/vela';
import { OnInboundEmail } from '@velajs/cloudflare';
import type { InboundEmail } from '@velajs/cloudflare';

@Injectable()
export class SupportInbox {
  // Runs ONLY if the app gate passed; `match` merely routes, it never relaxes the gate.
  @OnInboundEmail({ match: (e) => e.to.some((a) => a.includes('support@')) })
  async handle(email: InboundEmail) {
    // email.from is SPOOFABLE — authorize on email.authentication, not on from.
    // email.raw() / email.rawText() expose the bytes for BYO full-MIME parsing.
  }
}
```

Gating is **fail-closed**: the default policy requires `dmarc === 'pass'`; a missing `Authentication-Results` header, or any non-`pass` verdict, rejects. When the gate fails, **no handler runs** and the hook replies with a permanent SMTP reject carrying a fixed generic reason (never a verdict name or internal detail — the sender may be the attacker). A gate-passed message with no matching handler is dropped. Configure the policy via `MailModule.forRoot({ inbound: { gate: { require: ['dkim', 'spf', 'dmarc'] } } })`, or set `trustInternal: true` as the explicit escape hatch for trusted-internal MTAs.

### Full Worker export

```ts
const app = await createCloudflareApp(AppModule);

export default {
  fetch: app.fetch,
  scheduled: app.scheduled.bind(app),
  queue: app.queue.bind(app),
  email: app.email.bind(app),
};
```

### wrangler configuration

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  // Outbound: a send_email binding (name must match CloudflareEmailModule.forRoot({ binding })).
  // Optionally constrain recipients with destination_address / allowed_destination_addresses.
  "send_email": [{ "name": "SEND_EMAIL" }],
}
```

- **Inbound** is wired in the Cloudflare dashboard, not `wrangler.jsonc`: enable **Email Routing** on the zone, then add a routing rule **"Send to a Worker"** → this Worker (which exports `email`). `email.forward(...)` requires verified destination addresses.
- `cloudflare:email` and `cloudflare:workers` are built-in Workers modules — no dependency to install.

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
