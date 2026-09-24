# __PROJECT_NAME__

A Vela API on Cloudflare Workers: a validated todos resource stored in Workers
KV, a queue job for every created todo, a nightly cron job and the OpenAPI
document of its routes at `/openapi.json`. Requires
Node.js 24+. Local development needs no Cloudflare login: Vite runs the Worker
with local KV, queues and cron triggers.

```sh
__INSTALL__
__RUN__ dev
```

In another terminal:

```sh
curl -X POST http://localhost:5173/todos \
  -H 'content-type: application/json' -d '{"title":"Try Vela"}'
curl http://localhost:5173/todos
curl http://localhost:5173/openapi.json
```

## Layout

| File | Responsibility |
| --- | --- |
| `src/worker.ts` | `export default createCloudflareWorker(AppModule)` |
| `src/app.module.ts` | The queue driver (`QueueModule.forRoot`), `OpenApiModule` and the feature modules |
| `src/todos/todos.module.ts` | Registers the `todo-events` queue, the controller, service, processor and cron job |
| `src/todos/todos.controller.ts` | `GET/POST /todos`, `GET/PATCH/DELETE /todos/:id`, bodies validated with zod |
| `src/todos/todos.service.ts` | Reads and writes the `TODOS` KV namespace and adds a `todo.created` job |
| `src/todos/todo-events.processor.ts` | `@Processor('todo-events')`: handles `todo.created` jobs |
| `src/todos/todos.cron.ts` | `@Cron('0 3 * * *', { dialect: 'cloudflare' })`: purges completed todos |
| `src/notifications/` | The `Notifier` the processor injects |

Bindings (`TODOS`, `TODO_EVENTS`) and the cron trigger are declared in
`wrangler.jsonc`. `__RUN__ types` writes their types to
`worker-configuration.d.ts`, and providers read them through `ENV`:
`@InjectEnv() env: VelaEnv`. `__RUN__ dev` and `__RUN__ typecheck` regenerate
the file first. Commit it.

## Test

`__RUN__ test` runs `test/` inside the Workers runtime. `createTestingWorker()`
from `@velajs/cloudflare/testing` builds `AppModule` as `src/worker.ts` does and
drives the Worker's handlers: `fetch()` for HTTP, `queue()` with `queueJob()`
for queue batches, and `scheduled()` for cron triggers. Its `overrides` receive
the `@velajs/testing` builder: `overrideProvider()`, `overrideModule().useModule()`
and `useMocker()` for the dependencies nothing provides.

## Grow the application

`@velajs/cli` reads `main` from `wrangler.jsonc` and loads the application
through Vite, so no configuration file is needed:

```sh
__EXEC__ vela route list
__EXEC__ vela entrypoint list
__EXEC__ vela generate resource projects   # module, controller and service
__EXEC__ vela generate queue emails         # a @Processor and its QueueModule registration
__EXEC__ vela cf sync                       # compare wrangler.jsonc with the app
__EXEC__ vela cf sync --write               # add missing triggers, queues and Durable Objects
```

## Deploy

Authenticate with `__EXEC__ wrangler login`, create the queue once with
`__EXEC__ wrangler queues create __PROJECT_NAME__-todo-events`, then run
`__EXEC__ vela deploy check` and `__RUN__ deploy`. Wrangler creates the KV
namespace on the first deploy. `__RUN__ build` also copies `.dev.vars` into
`dist/` for `__RUN__ preview`; `dist/` is git-ignored and Wrangler does not
upload that file.

See the [Vela guides](https://github.com/velajs/vela/tree/main/docs) for modules,
queues, scheduling and testing.
