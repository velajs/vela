# Testing (`@velajs/testing`)

The official test harness. `Test.createTestingModule()` builds a real app from module metadata with DI overrides, then hands you a fluent HTTP/SSE/WebSocket client and DB/seed helpers. Subpaths: `.` and `./websocket-node`. Peers: `@velajs/vela`, `hono`, `vitest`.

## Build a module — `Test.createTestingModule().compile()`

```ts
import { Test } from '@velajs/testing';
import { MetadataRegistry } from '@velajs/vela';

beforeEach(() => MetadataRegistry.clear());   // reset global decorator metadata between cases

const moduleRef = await Test.createTestingModule({ imports: [CatsModule] })
  .overrideProvider(CatsService).useValue(fakeCats)
  .compile();

const service = moduleRef.get(CatsService);   // resolve from the root container
```

`Test.createTestingModule(metadata)` takes the same `ModuleOptions` as `@Module` (`imports/controllers/providers/exports`) and returns a builder. Override methods each return an `OverrideBy` with `.useValue(value)`, `.useClass(cls)`, and `.useFactory({ factory, inject? })`:

| Override | Targets |
|---|---|
| `overrideProvider(token)` | any provider token |
| `overrideGuard(Guard)` | a guard class |
| `overridePipe(Pipe)` | a pipe class |
| `overrideInterceptor(Interceptor)` | an interceptor class |
| `overrideFilter(Filter)` | an exception-filter class |

`.compile()` returns `Promise<TestingModule>`. (There is no `overrideMiddleware`.)

**Convention:** call `MetadataRegistry.clear()` (from `@velajs/vela`) in `beforeEach` — the registry is `globalThis`-anchored, so re-declared classes leak between cases otherwise.

## The `TestingModule`

| Member | Signature |
|---|---|
| `get(token)` | resolve a provider from the root container |
| `createApplication()` | `Promise<VelaApplication>` — the built app (use `.getHonoApp()` for raw `.request()`) |
| `http` | lazy `TestHttpClient` getter (see below) |
| `sse(path)` | `TestSseRequest` |
| `ws(path)` | `TestWsRequest` (needs the websocket-node transport, below) |
| `fetch(request, env?, ctx?)` | drive the full Hono pipeline with a raw `Request` |
| `setAuthResolver(resolver)` / `getAuthResolver()` | module-default `actingAs` resolver |
| `runInRequestScope(cb)` | `cb(container)` inside a fresh request-scoped child container |
| `seed(...SeederClasses)` | run registered `@Seeder` classes in request scope |
| `assertDatabaseHas/Missing/Count(db, ...)` | DB assertions against a `TestDatabase` |
| `close(signal?)` | dispose the app |

(There is no public `.app` property — use `createApplication()`.)

## HTTP client — `module.http` + `TestResponse`

```ts
const res = await module.http.post('/items').withBody({ name: 'A' }).send();
res.assertCreated();
await res.assertJsonPath('name', 'A');
```

`TestHttpClient`: `forHost(host)` and `withHeaders(headers)` return **new** immutable clients; `get/post/put/patch/delete(path)` return a `TestHttpRequest`. Build the request with `withBody(data)` (JSON-serialized, auto `Content-Type: application/json`), `withHeaders(headers)`, `asJson()`, `actingAs(principal, resolver?)`, then `send()` → `TestResponse`. Query strings go in the path (there is no `withQuery`).

`TestResponse` exposes `status`, `headers`, `raw`, and cached `json<T>()` / `text()`. Assertion methods (status/header ones are sync and return `this`; JSON ones are async and return `Promise<this>`):

- **Status:** `assertOk` (200), `assertCreated` (201), `assertNoContent` (204), `assertBadRequest` (400), `assertUnauthorized` (401), `assertForbidden` (403), `assertNotFound` (404), `assertUnprocessable` (422), `assertServerError` (500), `assertStatus(n)`, `assertSuccessful` (2xx).
- **JSON:** `assertJson(obj)` (top-level equality), `assertJsonPath(path, expected)`, `assertJsonPaths(map)`, `assertJsonStructure(keys[])`, `assertJsonPathExists(path)`, `assertJsonPathMissing(path)`, `assertJsonPathMatches(path, fn)`, `assertJsonPathContains(path, substr)`, `assertJsonPathIncludes(path, item)`, `assertJsonPathCount(path, n)` — paths are dot-notation.
- **Headers:** `assertHeader(name, expected?)`, `assertHeaderMissing(name)`.

## SSE & WebSocket

```ts
const sse = await module.sse('/stream/events').connect();
await sse.assertEvent({ event: 'message', data: 'ping', id: '1' });
```

`module.sse(path)` → `TestSseRequest` (`withHeaders`, `actingAs`, `connect()` — which asserts `200` + `text/event-stream`). `TestSseConnection`: `waitForEvent`, `waitForEnd`, `collectEvents`, `assertEvent`, `assertEventData`, `assertJsonEventData` (each takes an optional `timeout`, default 5000ms). `TestSseEvent` = `{ data, event?, id?, retry? }`.

WebSocket testing needs a transport adapter — on Node, **side-effect import `@velajs/testing/websocket-node`** (it calls `registerWsConnector` for you); without it `connect()` throws:

```ts
import '@velajs/testing/websocket-node';   // registers the Node WS connector

const ws = await module.ws('/rooms/room1/ws').connect();
ws.send(JSON.stringify({ event: 'echo', data: { text: 'hi' } }));
await ws.assertMessage(/* expected */);
```

`TestWsConnection`: `send`, `close`, `waitForMessage`, `waitForClose`, `assertMessage`, `assertClosed`. The connector seam is `registerWsConnector(connector)` / `getWsConnector()` (type `WsConnector`). Cloudflare Durable-Object sockets are exercised via `@velajs/cloudflare` + the workerd pool, not this harness.

## Request scope, seeding & database assertions

```ts
const id = await module.runInRequestScope(async (container) => container.resolve(RequestScopedProbe).requestId());

await module.seed(SecondSeeder, FirstSeeder);        // runs in @Seeder order, each in its own request scope

await module.assertDatabaseHas(db, 'user', { email: 'a@b.com' });
await module.assertDatabaseMissing(db, 'user', { email: 'x@y.com' });
await module.assertDatabaseCount(db, 'user', 2);
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

`actingAs` seams an auth principal onto a request. The resolver contract is `ActingAsResolver = (module, principal) => Promise<Headers>`; `TestPrincipal = Record<string, unknown>`. Set a module default with `module.setAuthResolver(resolver)`, or pass one per request:

```ts
const res = await module.http.get('/items/whoami')
  .actingAs({ id: 'u-1' }, async (_m, principal) => new Headers({ Authorization: `Bearer session-for-${principal.id}` }))
  .send();
```

`@velajs/better-auth/testing` exports a ready `actingAs` resolver that creates/signs a real session — see `references/auth.md`. `.actingAs(principal, resolver?)` is available on the HTTP, SSE, and WS requests.
