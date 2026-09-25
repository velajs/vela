# Testing (`@velajs/testing`)

The official test harness. `Test.createTestingModule()` builds a real app from module metadata with DI overrides, then hands you a fluent HTTP/SSE/WebSocket client and DB/seed helpers. Subpaths: `.` and `./websocket-node`. Peers: `@velajs/vela`, `hono`, `vitest`.

## Build a module — `Test.createTestingModule().compile()`

```ts
import { Test } from '@velajs/testing';

const moduleRef = await Test.createTestingModule({ imports: [CatsModule] })
  .overrideProvider(CatsService).useValue(fakeCats)
  .compile();

const service = moduleRef.get(CatsService);   // resolve from the root container
const session = await moduleRef.resolveInRequest(SessionState, { url: 'http://localhost/cats' }); // request-scoped
```

`Test.createTestingModule(metadata, options?)` takes the same `ModuleOptions` as `@Module` (`imports/controllers/providers/exports`) and returns a builder; `options` are exactly `VelaFactory.create`'s (`env` seeds the framework `ENV`, `adapters` bind `RuntimeAdapter`s, `globalPrefix`, `security`, `middleware`) through the production bootstrap (`overrideProvider(ENV)` also works). Override methods each return an `OverrideBy` with `.useValue(value)`, `.useClass(cls)`, and `.useFactory({ factory, inject })`:

| Override | Targets |
|---|---|
| `overrideProvider(token)` | any provider token |
| `overrideGuard(Guard)` | a guard class |
| `overridePipe(Pipe)` | a pipe class |
| `overrideInterceptor(Interceptor)` | an interceptor class |
| `overrideFilter(Filter)` | an exception-filter class |
| `overrideModule(Module).useModule(Replacement)` | every import of a module class (or of that exact `DynamicModule`), replaced by a class or `DynamicModule`; the metadata is untouched |
| `useMocker((token) => mock)` | every non-optional dependency no provider satisfies (a `NestModule` class's constructor dependencies included, before its `configure()` runs), called once per token before anything is constructed; a falsy result leaves the dependency unresolved, so `compile()` rejects with `UnresolvedDependencyError` |

Overrides infer their value/class/result contract from the token. A factory override types its parameters from its `inject` tuple, which a factory without parameters may omit (`useFactory({ factory: () => fake })`); erased runtime identities cannot authorize typed replacements.

`.compile()` returns `Promise<TestingModule>`. (There is no `overrideMiddleware`.)

```ts
import { Module } from '@velajs/vela';
import { Test } from '@velajs/testing';

@Module({})
class NoMail {}

const moduleRef = await Test.createTestingModule({ imports: [SignupModule] })
  .overrideModule(MailModule)
  .useModule(NoMail)
  .useMocker((token) => (token === MailService ? { send: async () => {} } : undefined))
  .compile();
```

## Workers handlers — `@velajs/cloudflare/testing`

Inside the Workers Vitest pool, `createTestingWorker(AppModule, { env?, overrides?, ...workerOptions })` builds the module exactly as `createCloudflareWorker(AppModule, workerOptions)` does, through this builder, and drives the Worker handlers (it needs `@velajs/testing` installed):

```ts
import { env } from 'cloudflare:workers';
import { createTestingWorker, queueJob } from '@velajs/cloudflare/testing';

const worker = await createTestingWorker(AppModule, {
  env, // default: the pool's env from cloudflare:workers
  overrides: (module) => module.overrideProvider(Clock).useValue(fixedClock),
});
const response = await worker.fetch('/todos');                  // paths resolve against http://localhost
const result = await worker.queue('todo-events', [queueJob('todo-events', todoCreated, { id: '1' })]);
result.outcome;       // 'ok' | 'exception' (the handler rejected: unacknowledged messages retry)
result.explicitAcks;  // message ids acknowledged one by one
await worker.scheduled('0 3 * * *'); // rejects when no @Cron job declares the expression
await worker.close();                // waits for waitUntil work; cancels unread response bodies
```

`queue()` uses `createMessageBatch`/`getQueueResult` and `scheduled()` `createScheduledController` from `cloudflare:test`; `queueJob(queue, jobOrName, data, { id?, attempts? })` builds the job envelope `QueueClient.add()` sends. `worker.module` is the `TestingModule` (`get`, `http`, `resolveInRequest`).

Compilation shares production finalization and recomputes effective scopes after
overrides. Always await `close()` to run shutdown hooks and dispose owned
resources, even when a hook fails. Concurrent closes share completion, and a
closed harness rejects new requests/scopes. Consume or cancel response streams
and await scope callbacks before shutdown; Node WebSocket servers/connectors
registered with the harness are closed with it.

No per-test cleanup is needed: decorator metadata is permanent for the process and holds no application state, so each compiled module starts from its own container. Declare test classes inside the test (or a fixture function) when cases need distinct metadata.

## The `TestingModule`

| Member | Signature |
|---|---|
| `get(token)` | resolve a provider from the root container (throws for request-scoped tokens) |
| `resolveInRequest(token, init?)` | `Promise` of the token resolved in a fresh request scope seeded from `init` (`RequestInit` + `url`); the scope stays open until `close()` |
| `createApplication()` | `Promise<VelaApplication>` — the built app (use `.getHonoApp()` for raw `.request()`) |
| `http` | lazy `TestHttpClient` getter (see below) |
| `sse(path)` | `TestSseRequest` |
| `ws(path)` | `TestWsRequest` (needs the websocket-node transport, below) |
| `fetch(request, env?, ctx?)` | drive the full Hono pipeline with a raw `Request` |
| `setAuthResolver(resolver)` / `getAuthResolver()` | module-default `actingAs` resolver |
| `runInRequestScope(cb, init?)` | `cb(container)` inside a fresh child with the production request context and typed request-key storage |
| `seed(...SeederClasses)` | run registered `@Seeder` classes in request scope |
| `assertDatabaseHas/Missing/Count(db, ...)` | DB assertions against a `TestDatabase` |
| `close(signal?)` | dispose the app |

(There is no public `.app` property — use `createApplication()`.)

`createTestHttpClient` accepts a remote HTTP transport when an in-process module
is unnecessary. Remote tests exercise the target server's authentication and
cannot inject trusted identity through client-side flags. Response validation
uses the shared async schema parser, preserving transformation output types.

## HTTP client — `moduleRef.http` + `TestResponse`

```ts
const res = await moduleRef.http.post('/items').withBody({ name: 'A' }).send();
res.assertCreated();
await res.assertJsonPath('name', 'A');
```

`TestHttpClient`: `forHost(host)` and `withHeaders(headers)` return **new** immutable clients; `get/post/put/patch/delete(path)` return a `TestHttpRequest`. Build the request with `withBody(data)` (JSON-serialized, auto `Content-Type: application/json`), `withHeaders(headers)`, `asJson()`, `actingAs(principal, resolver?)`, then `send()` → `TestResponse`. Query strings go in the path (there is no `withQuery`).

`TestResponse` exposes `status`, `headers`, `raw`, and cached `json(): Promise<unknown>` / `text()`. Pass a schema to `json(schema)` to validate and infer its output. Assertion methods (status/header ones are sync and return `this`; JSON ones are async and return `Promise<this>`):

- **Status:** `assertOk` (200), `assertCreated` (201), `assertNoContent` (204), `assertBadRequest` (400), `assertUnauthorized` (401), `assertForbidden` (403), `assertNotFound` (404), `assertUnprocessable` (422), `assertServerError` (500), `assertStatus(n)`, `assertSuccessful` (2xx).
- **JSON:** `assertJson(obj)` (top-level equality), `assertJsonPath(path, expected)`, `assertJsonPaths(map)`, `assertJsonStructure(keys[])`, `assertJsonPathExists(path)`, `assertJsonPathMissing(path)`, `assertJsonPathMatches(path, fn)`, `assertJsonPathContains(path, substr)`, `assertJsonPathIncludes(path, item)`, `assertJsonPathCount(path, n)` — paths are dot-notation.
- **Headers:** `assertHeader(name, expected?)`, `assertHeaderMissing(name)`.

## SSE & WebSocket

```ts
const sse = await moduleRef.sse('/stream/events').connect();
await sse.assertEvent({ event: 'message', data: 'ping', id: '1' });
```

`moduleRef.sse(path)` → `TestSseRequest` (`withHeaders`, `actingAs`, `connect()` — which asserts `200` + `text/event-stream`). `TestSseConnection`: `waitForEvent`, `waitForEnd`, `collectEvents`, `assertEvent`, `assertEventData`, `assertJsonEventData` (each takes an optional `timeout`, default 5000ms). `TestSseEvent` = `{ data, event?, id?, retry? }`.

WebSocket testing needs a transport adapter — on Node, **side-effect import `@velajs/testing/websocket-node`** (it calls `registerWsConnector` for you); without it `connect()` throws:

```ts
import '@velajs/testing/websocket-node';   // registers the Node WS connector

const ws = await moduleRef.ws('/rooms/room1/ws').connect();
ws.send(JSON.stringify({ event: 'echo', data: { text: 'hi' } }));
await ws.assertMessage(/* expected */);
```

`TestWsConnection`: `send`, `close`, `waitForMessage`, `waitForClose`, `assertMessage`, `assertClosed`. The connector seam is `registerWsConnector(connector)` / `getWsConnector()` (type `WsConnector`). Cloudflare Durable-Object sockets are exercised via `@velajs/cloudflare` + the workerd pool, not this harness. So are `VelaDurableObject` hosts: call `env.COUNTER.getByName(name).method()` (from `cloudflare:workers`) in a workerd spec, and `runDurableObjectAlarm(stub)` from `cloudflare:test` for alarms.

## Request scope, seeding & database assertions

```ts
const id = await moduleRef.runInRequestScope(async (container) => container.resolve(RequestScopedProbe).requestId());

await moduleRef.seed(SecondSeeder, FirstSeeder);        // runs in @Seeder order, each in its own request scope

await moduleRef.assertDatabaseHas(db, 'user', { email: 'a@b.com' });
await moduleRef.assertDatabaseMissing(db, 'user', { email: 'x@y.com' });
await moduleRef.assertDatabaseCount(db, 'user', 2);
```

`seed(...classes)` resolves `SeederRegistry` (from `@velajs/vela/seeder`) and throws if a class isn't registered. `TestDatabase` is a **consumer-implemented** contract the harness ships no driver for:

```ts
interface TestDatabase {
  truncate(): Promise<void>;
  has(table: string, where: Record<string, unknown>): Promise<boolean>;
  count(table: string): Promise<number>;
}
```

## Authenticating requests — `actingAs`

`actingAs` seams an auth principal onto a request. The resolver contract is `ActingAsResolver = (module, principal) => Promise<Headers>`; `TestPrincipal = Record<string, unknown>`. Set a module default with `moduleRef.setAuthResolver(resolver)`, or pass one per request:

```ts
const res = await moduleRef.http.get('/items/whoami')
  .actingAs({ id: 'u-1' }, async (_m, principal) => new Headers({ Authorization: `Bearer session-for-${principal.id}` }))
  .send();
```

`@velajs/better-auth/testing` exports a ready `actingAs` resolver that creates/signs a real session — see `references/auth.md`. `.actingAs(principal, resolver?)` is available on the HTTP, SSE, and WS requests.
