# Durable Objects

A Vela Durable Object is a class whose instances each boot one application
context from your module graph. A host class, an ordinary `@Injectable()`,
provides its behavior: the methods you list in `rpc` become the class's JS-RPC
methods, and `fetch`, `alarm` and the WebSocket hibernation handlers become its
event handlers. Every call and event runs through the same guard, pipe, interceptor
and filter pipeline as the rest of the application, in its own execution
scope.

## One app definition

Define the application once in the Worker entry. Its Worker and the Durable
Object classes defined from it share the root module and the options:

```ts
// src/worker.ts
import { defineCloudflareApp } from '@velajs/cloudflare';
import { VelaDurableObject, VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';
import { AppModule } from './app.module.js';
import { CounterHost } from './counter/counter.host.js';

const app = defineCloudflareApp(AppModule, { globalPrefix: '/api' });

export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment', 'reset'] }) {}
export class ChatRoom extends VelaWebSocketDurableObject(app) {}
export default app.worker;
```

- `app.worker` is the Worker's handlers. It builds one application per
  environment identity; concurrent cold events share construction, and a
  failed construction is retried by the next event.
  `createCloudflareWorker(AppModule, options)` is
  `defineCloudflareApp(AppModule, options).worker`, for an entry that exports
  no Durable Object built from the app.
- Each Durable Object instance boots its own application context from the
  same root, configured by the app's runtime `adapters` (their
  `configureContainer`, as in the Worker). The HTTP options (`globalPrefix`,
  `security`, `configure`) apply to the Worker only.
- `VelaDurableObject(AppModule, CounterHost, { rpc })` and
  `VelaWebSocketDurableObject(AppModule)` take a bare root instead: the same
  class, without the app's adapters.
- A Durable Object class uses the app when it is defined, so declare it in the
  module that defines the app, as above. A class in its own file cannot import
  the app from the Worker entry: the entry imports that file first, so the app
  is not defined yet when the class is. To keep classes in their own files,
  define the app in a module of its own and import it from the Worker entry and
  from each class's file:

  ```ts
  // src/app.ts
  export const app = defineCloudflareApp(AppModule, { adapters: [reporting] });

  // src/counter/counter.durable-object.ts
  import { app } from '../app.js';
  export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment'] }) {}

  // src/worker.ts
  import { app } from './app.js';
  export { Counter } from './counter/counter.durable-object.js';
  export default app.worker;
  ```
- The Worker's descriptor lists the Durable Object classes defined from the app,
  and each class carries its own descriptor, so `vela cf sync` and
  `vela deploy check` know what each exported class serves.

The root entry `@velajs/cloudflare` never imports `cloudflare:workers`, which
Durable Object classes extend for JS-RPC. The classes therefore come from the
`@velajs/cloudflare/durable-objects` subpath and take the app as an argument. A
Worker that defines none bundles none of their code.

## Hosts and RPC

```ts
// src/counter/counter.host.ts
import { Inject, Injectable, UseGuards } from '@velajs/vela';
import { DO_ID, DO_STORAGE } from '@velajs/cloudflare/durable-objects';
import { CallerGuard } from '../caller.guard.js';

@Injectable()
export class CounterHost {
  constructor(
    @Inject(DO_STORAGE) private readonly storage: DurableObjectStorage,
    @Inject(DO_ID) private readonly id: DurableObjectId,
  ) {}

  async increment(by: number): Promise<number> {
    const value = ((await this.storage.get<number>('value')) ?? 0) + by;
    await this.storage.put('value', value);
    return value;
  }

  @UseGuards(CallerGuard)
  async reset(): Promise<void> {
    await this.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    await this.increment(1);
  }
}
```

Bind the class in Wrangler (`vela cf sync --write` adds the binding and a
migration) and regenerate the environment types. `wrangler types` types the
binding with the exported class, so its stubs expose the host's signatures:

```ts
@Injectable()
export class OrdersService {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  count(name: string): Promise<number> {
    // DurableObjectNamespace<Counter>: increment(by: number) returns Promise<number>.
    return this.env.COUNTER.getByName(name).increment(1);
  }
}
```

- **RPC methods.** Exactly the host methods the `rpc` option names, and the
  stub type exposes exactly those. Nothing else is reachable over RPC, even
  from plain JavaScript that names another method on a stub: not an unlisted
  public method, a TypeScript `private` or `protected` helper (which is an
  ordinary prototype method at runtime), a lifecycle hook or `dispose()`.
  Without `rpc`, the object serves only its event handlers. The list is typed:
  it accepts the host's public methods only. When the class is defined, each
  name must be a method declared in the host's class body or inherited;
  accessors and instance fields (such as `increment = async () => ...`) are
  not on the prototype and are rejected. Hooks (`onModuleInit`, ...,
  `dispose`, `collectEntrypoints`), the event handlers, and `ctx`, `env`,
  `connect`, `dup`, `id` and `name`, which the class or its stubs own, are
  rejected too.
- **Handlers.** When the host defines `fetch(request)`, `alarm(info)`,
  `webSocketMessage`, `webSocketClose` or `webSocketError`, the class delegates
  that event to it. A host without `alarm` gets no alarm handler, so
  `setAlarm()` needs one.
- **Injection.** The host is added to the root module's providers inside the
  object, so it injects what that module can: its providers, its imports'
  exports and global tokens. Do not list it in a module the Worker also builds.
  Every Durable Object context seeds `ENV` (the object's own environment) and
  registers `DO_STATE` (its `DurableObjectState`), `DO_STORAGE` (`state.storage`)
  and `DO_ID` (`state.id`) as global tokens. A provider the Worker builds too
  can read them with `@Optional()`. `Gateways` pushes and live invalidations
  reach each gateway room's object, as from the Worker.

## Lifecycle and scopes

Each instance boots its context in the constructor, under
`blockConcurrencyWhile`, with the production bootstrap
(`VelaFactory.createApplicationContext`): providers are constructed and
`onModuleInit` and `onApplicationBootstrap` run before any event is delivered.
Singleton providers therefore live as long as the instance, one per object;
two objects, or the same object in two environments, never share one. The
platform evicts idle instances without notice, so shutdown hooks do not run
then: keep durable state in `DO_STORAGE`.

Each RPC call and event runs in a fresh execution scope, like an HTTP request:
request-scoped providers (and a host that depends on one) are built for that
invocation, and `EXECUTION_LIFETIME` work (`defer`, `waitUntil`) settles before
the call returns. A `fetch()` response with a streamed body keeps its scope open,
as the HTTP edge does, until the body is read, fails or is cancelled; the scope
then finishes under the object's `waitUntil`. A failure of that work is
reported; it fails an alarm, so the platform retries it, but not an RPC call
that already succeeded.

## The pipeline

Guards, pipes, interceptors and filters declared on the host class or method
(`@UseGuards`, `@UsePipes`, `@UseInterceptors`, `@UseFilters`, inherited as in
Nest) run around every invocation. Application-wide `APP_*` components do not:
a Durable Object's callers are Workers and the platform, not HTTP requests, as
for queue batches and cron triggers.

The `ExecutionContext` reports `getType()` `'rpc'` for an RPC call, and
`'cf:do:fetch'`, `'cf:do:alarm'` or `'cf:do:websocket'` for the handlers
(`DurableObjectInvocationKind`). `getClass()` is the host, `getHandler()` the
method, and `getPayload()` the invocation's arguments. Pipes transform RPC
arguments only, each with `{ type: 'custom' }` and its reflected parameter type.
A guard that returns `false` fails the call with `403 forbidden`.

## Errors

A failure is reported first, through the application's `ExceptionHandler`
(`edge: 'durable-object'`, with the host method as `source`). Then:

- An RPC call rejects with a `DurableObjectError` and nothing else. It is
  rendered like an HTTP response (`renderHttpError`, server bodies redacted):
  a 4xx `HttpException` or branded `VelaError` keeps its `status`, `code`,
  `message` and `details`; anything else becomes
  `500 internal "Internal Server Error"`. Its stack names only itself, so no
  frame, cause or property of the original error crosses the RPC boundary.
  workerd rebuilds it for the caller as a plain `Error` with those properties;
  test it with `isDurableObjectError(error)`. workerd keeps an error's own
  properties across RPC only from `compatibility_date` 2026-04-21, or with the
  `enhanced_error_serialization` compatibility flag. On an older date the
  caller receives an `Error` whose message is `DurableObjectError: <message>`,
  with no `status`, `code` or `details`, and `isDurableObjectError()` is false;
  `vela deploy check` warns about it. A host may throw a
  `DurableObjectError` itself, for example to pass another object's failure
  on: a client fault (4xx) keeps its code, message and details, and a server
  fault keeps only its status.
- `fetch()` answers with the JSON error body and status, as a controller does.
- Alarms and WebSocket events rethrow the error to the platform, which logs it
  and retries alarms.

A scoped exception filter that catches the error runs, closest first. For an
RPC call, a value it returns becomes the call's result; `undefined` keeps the
failure. For `fetch()`, a returned `Response` is sent, and any other value is
sent as JSON with the error's status. For alarms and WebSocket events, a filter
that catches the error handles it. A filter that throws replaces the error.

When the context fails to start, the object logs the error and resets, so the
next event boots it again; every waiting caller receives only
`500 internal "Internal Server Error"`.

## WebSocket rooms

`VelaWebSocketDurableObject(app)` is the Durable Object that holds a gateway
room's hibernatable sockets (see [WebSockets](websockets.md)). It boots its
context the same way: it injects `DO_STATE`, `DO_STORAGE` and `DO_ID`, and the
app's adapters configure it. Its platform differs: pushes to its own room and
live invalidations are delivered locally, and the live cursor log lives in its
SQLite storage.

## Standalone application contexts

`VelaFactory.createApplicationContext(AppModule, options)` is the bootstrap each
Durable Object uses, available on its own, as Nest's
`NestFactory.createApplicationContext`: the module graph, its providers,
lifecycle hooks and entrypoints, without HTTP routes. Use it for scripts,
custom runtimes and tests:

```ts
const context = await VelaFactory.createApplicationContext(AppModule, { env });
const reports = context.get(ReportsService);
const users = context.select(UsersModule).get(UsersService, { strict: true });
const perCall = await context.resolve(RequestScopedService, scope);
await context.close();
```

`get()` looks a token up across the application, `{ strict: true }` as the
selected module sees it: its own providers, its imports' exports and global
tokens, the visibility `ModuleRef` uses. This differs from Nest, where strict
lookup finds only the providers the selected module declares itself. `resolve()` awaits async factories, constructs
transient providers anew and resolves request-scoped ones in the execution
scope you pass. `init()` is idempotent; `close()` runs the shutdown hooks and
`dispose()` also releases the container. `VelaApplication` extends it.

## Wrangler, tooling and tests

- `vela g durable-object counter` writes `counter.host.ts` and a class whose
  `rpc` lists the host's `increment` method. When the Worker entry binds its
  app (`const app = defineCloudflareApp(...)`), it declares
  `export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment'] }) {}`
  in the entry, after the app. When the entry imports the app from its own
  module, it writes `counter.durable-object.ts` importing that app. Otherwise it
  builds the class from the root module in `counter.durable-object.ts`, exported
  from the entry, and says so when the entry passes options (such as runtime
  adapters) that the class then does not share.
- `vela cf sync --write` binds every exported class and adds it to a migration
  as a SQLite class. A gateway binding no class serves is bound to the one
  exported `VelaWebSocketDurableObject` class.
- `vela entrypoint list` lists the exported classes as `cf:durable-object`
  rows, and `vela deploy check` warns about exported classes the selected
  environment does not bind and classes the app defines but does not export.
  See [deployment](deployment.md).
- Test inside workerd with `@cloudflare/vitest-plugin`: call
  `env.COUNTER.getByName(name)` from `cloudflare:workers`, and run a scheduled
  alarm with `runDurableObjectAlarm(stub)` from `cloudflare:test`.
