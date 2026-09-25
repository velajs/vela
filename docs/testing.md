# Testing

Vela tests build real applications through the production bootstrap. Two tools
share one builder:

- `Test.createTestingModule()` from `@velajs/testing` composes modules in any
  runtime (Node or workerd), overrides providers and modules, and sends HTTP,
  SSE and WebSocket requests. See the [package guide](../packages/testing/README.md).
- `createTestingWorker()` from `@velajs/cloudflare/testing` builds a Worker's
  root module as `createCloudflareWorker()` does and drives its `fetch`, `queue`
  and `scheduled` handlers inside the Workers Vitest pool.

Projects created by `vela new` run their specs in workerd with
`@cloudflare/vitest-plugin`: `vitest.config.ts` applies the shared Oxc decorator
options and `cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })`,
so specs see the bindings the Wrangler file declares.

## Worker handlers

```ts
import { env } from 'cloudflare:workers';
import { createTestingWorker, queueJob } from '@velajs/cloudflare/testing';
import { expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { TODO_EVENTS, todoCreated } from '../src/todos/todo-events.js';

it('serves, processes jobs and runs cron jobs', async () => {
  const worker = await createTestingWorker(AppModule, { env });
  try {
    const created = await worker.fetch('/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Write tests' }),
    });
    expect(created.ok).toBe(true);

    const result = await worker.queue(TODO_EVENTS, [
      queueJob(TODO_EVENTS, todoCreated, { id: 'todo-1', title: 'Write tests' }),
    ]);
    expect(result.outcome).toBe('ok');

    await worker.scheduled('0 3 * * *');
  } finally {
    await worker.close();
  }
});
```

`createTestingWorker(rootModule, options)` accepts the options of
`createCloudflareWorker()` (`globalPrefix`, `security`, `adapters`, and the
`configure(app, env)` hook, which it runs on the application it builds) plus:

- `env`: the environment the application is built for and every event carries.
  It defaults to the pool's `env` from `cloudflare:workers`.
- `overrides`: a function that receives the `@velajs/testing` builder before it
  compiles (see below).

The returned worker offers:

| Member | Behavior |
| --- | --- |
| `fetch(input, init?)` | Sends a request through the Worker's `fetch` handler; a path resolves against `http://localhost`. |
| `queue(queue, messages)` | Delivers one batch of the physical queue through the Worker's `queue` handler, built with `cloudflare:test`'s `createMessageBatch()`, and returns `getQueueResult()`: `explicitAcks`, `ackAll`, `retryMessages`, `retryBatch`, plus `outcome` (`'exception'` and `error` when the handler rejected, after which Cloudflare retries every unacknowledged message). |
| `scheduled(cron, { scheduledTime? })` | Fires the cron trigger with `createScheduledController()` and waits for its `@Cron` jobs. It rejects when no job declares `cron`: Cloudflare delivers the literal trigger expression. |
| `module` | The compiled `TestingModule`: `get()`, `resolveInRequest()`, the fluent `http` client. |
| `close()` | Cancels response bodies the test never read, waits for background work (`waitUntil`) and closes the application. |

`queueJob(queue, job, data, { id?, attempts? })` builds the message
`QueueClient.add()` sends: `queue` is the logical queue a `@Processor` handles,
and `job` a `defineQueueJob()` definition (whose wire input `data` must match)
or a job name. The physical queue passed to `worker.queue()` is the Cloudflare
queue the batch arrives on; a registration without a `consumer` pin accepts jobs
from any of them.

The subpath imports `cloudflare:test`, so it only runs inside the Workers
Vitest pool, and it needs `@velajs/testing` installed. It is never part of a
Worker bundle.

## Overrides

`overrides` (or the builder `Test.createTestingModule()` returns) replaces parts
of the graph without touching the application's modules:

```ts
import { Module } from '@velajs/vela';
import { createTestingWorker } from '@velajs/cloudflare/testing';
import { AppModule } from '../src/app.module.js';
import { NotificationsModule } from '../src/notifications/notifications.module.js';
import { Notifier } from '../src/notifications/notifier.service.js';

@Module({})
class SilentNotifications {}

const notified: string[] = [];
const worker = await createTestingWorker(AppModule, {
  overrides: (module) =>
    module
      .overrideModule(NotificationsModule)
      .useModule(SilentNotifications)
      .useMocker((token) =>
        token === Notifier ? { notify: (message: string) => notified.push(message) } : undefined,
      ),
});
```

- `overrideProvider(token)`, `overrideGuard()`, `overridePipe()`,
  `overrideInterceptor()` and `overrideFilter()` replace one provider with
  `useValue`, `useClass` or `useFactory`, in every module that holds it. The
  replacement's type is checked against the token.
- `overrideModule(Module).useModule(Replacement)` loads the replacement, a
  module class or a `DynamicModule`, wherever the graph imports the module class
  (or exactly the `DynamicModule` object passed). The module's own metadata is
  not modified.
- `useMocker(factory)` supplies the dependencies nothing provides, as in Nest:
  `factory(token)` runs once for each token a constructor or factory injects that
  no visible provider satisfies, before anything is constructed, and its value is
  registered in each module that needs it. A falsy result (such as `undefined`)
  supplies nothing, so the dependency stays unresolved and compiling fails with
  `UnresolvedDependencyError`. Optional parameters, `ModuleRef`, `InjectionToken`
  defaults and provided or overridden tokens never reach it.

Overrides apply after the graph loads and before construction, so replaced
providers are never built and effective request scopes are recomputed. They
reach module classes too: a module that implements `NestModule` is built with
the overridden and mocked providers before its `configure(consumer)` runs. An
`OpenApiModule` document describes the controllers the testing module serves,
so a module replaced with `overrideModule()` is documented as its replacement.

## Modules without a Worker

`Test.createTestingModule(metadata, options)` takes the same options as
`VelaFactory.create()` (`env`, `adapters`, `globalPrefix`, …) and works in Node
and workerd alike:

```ts
import { Test } from '@velajs/testing';

const moduleRef = await Test.createTestingModule({ imports: [UsersModule] })
  .overrideProvider(UsersRepository)
  .useValue(fakeRepository)
  .compile();
try {
  const response = await moduleRef.http.get('/users').send();
  response.assertOk();
} finally {
  await moduleRef.close();
}
```

Pass `{ env, adapters: [cloudflareAdapter({ env })] }` to exercise the
Cloudflare adapter without the Worker handlers. See the
[package guide](../packages/testing/README.md) for the HTTP, SSE and WebSocket
clients, request scopes, seeding and database assertions.
