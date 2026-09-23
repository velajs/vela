# @velajs/testing

[![npm version](https://img.shields.io/npm/v/@velajs/testing)](https://www.npmjs.com/package/@velajs/testing)
[![License: MIT](https://img.shields.io/npm/l/@velajs/testing)](https://github.com/velajs/vela/blob/main/packages/testing/LICENSE)

Test-module builder for [Vela](https://github.com/velajs/vela). Compose modules in isolation, override providers/guards/pipes/interceptors/filters, and exercise controllers via Hono's `app.request()`. Testing uses the production bootstrap and finalization path, including signed internal dispatch and lifecycle hooks.

## Install

```bash
pnpm add -D @velajs/testing
# Required peers: @velajs/vela ^1.22.1, hono >=4, vitest >=3
```

No `reflect-metadata` needed — Vela ships its own polyfill.

## Quick Start

```ts
import { describe, it, expect } from 'vitest';
import { Test } from '@velajs/testing';
import { Injectable, Module } from '@velajs/vela';

@Injectable()
class CatsService {
  findAll() { return ['cat1', 'cat2']; }
}

@Module({ providers: [CatsService] })
class CatsModule {}

describe('CatsService', () => {
  it('returns cats', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CatsModule],
    }).compile();

    try {
      expect(moduleRef.get(CatsService).findAll()).toEqual(['cat1', 'cat2']);
    } finally {
      await moduleRef.close();
    }
  });
});
```

Keep module decorators registered until the test completes. Clearing
`MetadataRegistry` after declaring a module removes the metadata that `compile()`
needs. Close each compiled module to run its shutdown hooks and dispose constructed
providers. Concurrent calls to \`close()\` await the same completion. Register owned
fixtures with \`moduleRef.onClose(async () => { /* cleanup */ })\`; callbacks run in
reverse order, and cleanup continues after a failure. The Node WebSocket adapter
registers its server automatically, so closing the module closes active sockets
and the listening port. A closed module rejects new requests and scopes.

\`runInRequestScope\` uses a managed invocation lifetime, seeds \`REQUEST_CONTEXT\`,
and drains deferred work before disposing the child. Module shutdown waits for
already-running scope callbacks. Always await HTTP response bodies and close
SSE connections before tearing down a test that consumes streaming responses.

## Overriding providers

```ts
const moduleRef = await Test.createTestingModule({ imports: [UsersModule] })
  .overrideProvider(UsersService)
  .useValue({ getUsers: () => ['mock-user'] })
  .compile();
```

`useValue`, `useClass`, and `useFactory` are all supported. Same builder for `overrideGuard`, `overridePipe`, `overrideInterceptor`, `overrideFilter`.

`get(token)` and overrides infer their value contract from a class or `InjectionToken<Value>`. An incompatible mock fails typechecking. Raw string/symbol tokens resolve to `unknown`; use an injection token when the contract matters.

```ts
.overrideGuard(AuthGuard).useValue({ canActivate: () => true })
.overrideInterceptor(LogInterceptor).useClass(NoopInterceptor)
.overrideProvider(CONFIG).useFactory({
  factory: (env) => ({ env: env.APP_ENV }),
  inject: [ENV],
})
```

Here `ENV` is the framework environment token from `@velajs/vela`, with
`APP_ENV: string` declared on `VelaEnv`, and `CONFIG` is an
`InjectionToken<{ env: string }>`.

### Environment and runtime adapters

The builder's second argument seeds the application's `ENV` and binds runtime
adapters through the same bootstrap as `VelaFactory.create`:

```ts
const moduleRef = await Test.createTestingModule(
  { imports: [ReportsModule] },
  { env: { APP_ENV: 'test' }, adapters: [myRuntimeAdapter] },
).compile();
```

Adapter `configureContainer`, request middleware, client-IP resolution and
lifecycle hooks all apply, and `registerAs` namespaces read the seeded `env`.
`moduleRef.fetch()` and the HTTP and SSE builders send each request with the
seeded `env` as `c.env` (an explicit `fetch(request, env)` argument wins), so an
adapter that binds requests to its environment accepts them. Pass it the same
object, for example `{ env, adapters: [cloudflareAdapter({ env })] }`.
`overrideProvider(ENV).useValue(env)` replaces the environment for every module,
with or without a seeded `env`.

Inline providers (skip importing a module):

```ts
const moduleRef = await Test.createTestingModule({
  providers: [InlineService, defineProvider(CONFIG, { useValue: { env: 'test' } })],
}).compile();
```

Import `defineProvider` from `@velajs/vela`. Factory dependency types come from the `inject` tuple, which a factory without parameters may omit, in providers and in `overrideProvider(TOKEN).useFactory({ factory, inject })`.
Overrides recompute request-scope propagation, including dependencies introduced
or removed by a replacement factory. Compile separate testing modules to keep
application/environment-specific replacements independent.

For implementations with private state, inject a small interface token rather
than casting a partial object to the concrete class:

\`\`\`ts
interface Database { read(id: string): Promise<string>; }
const DATABASE = new InjectionToken<Database>('database');
const fake = { read: async (id: string) => id } satisfies Database;
const moduleRef = await Test.createTestingModule({
  providers: [defineProvider(DATABASE, { useValue: fake })],
}).compile();
\`\`\`

Direct constructor tests remain useful when no module graph or request pipeline
is involved. No mock superclass or assertion cast is required.

## HTTP testing

```ts
const moduleRef = await Test.createTestingModule({ imports: [ItemsModule] }).compile();
const app = await moduleRef.createApplication();

const res = await app.getHonoApp().request('/items');
expect(res.status).toBe(200);
expect(await res.json()).toEqual([{ id: 1, name: 'Item 1' }]);
```

The fluent HTTP client returns `TestResponse`. Its `json()` method returns `unknown`; pass a schema or `defineDto` descriptor to validate the body and infer its output:

```ts
const response = await moduleRef.http.get('/items').send();
const items = await response.json(z.array(z.object({ id: z.number(), name: z.string() })));
expect(items[0]?.name).toBe('Item 1');
```

`runInRequestScope(callback, init?)` creates a real framework request context, including typed `RequestContextKey` storage, and disposes its child container when the callback finishes.

`get(token)` resolves from the root container and throws for request-scoped providers. Resolve those with `resolveInRequest`, which opens a fresh request scope per call, seeded from an optional `RequestInit` plus `url`. The scope stays open until `close()`, so the returned instance and its request dependencies remain usable during the test:

```ts
const session = await moduleRef.resolveInRequest(SessionState, {
  url: 'http://localhost/cats',
  headers: { 'x-request-id': 'test-1' },
});
```

## Lifecycle

`compile()` calls `onModuleInit` and `onApplicationBootstrap` automatically. `moduleRef.close()` triggers `onModuleDestroy` and `onApplicationShutdown`.

## API

| Export | Purpose |
|---|---|
| `Test.createTestingModule(metadata)` | Returns a `TestingModuleBuilder`. |
| `TestingModuleBuilder` | Chain `overrideProvider/Guard/Pipe/Interceptor/Filter`, then `.compile()`. |
| `TestingModule` | Result of `compile()`: `get(token)`, `createApplication()`, `close()`. |
| `OverrideBy` | The fluent intermediate from `overrideX()` — exposed for type-narrowing. |

## Output scoring / evals

`@velajs/testing/eval` is a small, model-agnostic harness for grading the output of any string-producing function — an LLM turn, an agent loop, a formatter — against heuristics or an injected LLM judge. It pulls in no AI SDK: the only model touchpoint is `llmScorer`, whose `judge` is a plain callback you supply.

```ts
import { evaluate, keyword, llmScorer } from '@velajs/testing/eval';

const report = await evaluate(
  [{ input: 'where is my order?', expected: 'shipped' }],
  async (input) => askSupportAgent(input),
  {
    coverage: keyword(['shipped']),
    helpful: llmScorer({ criteria: 'answers the question', judge: myModel }),
  },
);

expect(report.aggregate.overall).toBeGreaterThan(0.5);
```

Each scorer returns a `[0, 1]` score (auto-clamped) with an optional reason. `evaluate` runs every case through the producer, grades each output with every scorer, and returns per-case reports plus an aggregate (`perScorer` means and an `overall` mean).

| Export | Purpose |
|---|---|
| `evaluate(dataset, run, scorers)` | Grade a dataset; returns `{ cases, aggregate }`. |
| `exactMatch(options?)` | 1 when the output equals `expected` (trimmed by default). |
| `contains(needles, options?)` | Substring match, `all`-of (default) or `any`-of. |
| `keyword(keywords, options?)` | Fractional coverage — the share of keywords present. |
| `regex(pattern)` | 1 when the pattern matches (global/sticky flags stripped for reuse). |
| `llmScorer({ criteria, judge })` | LLM-as-judge with an injected `judge` callback; fails soft to 0. |
| `Scorer` | `(input) => number \| ScoreResult` (sync or async) — write your own. |

## How it's wired

`@velajs/testing` consumes vela's framework primitives via `@velajs/vela/internal` (`MetadataRegistry`, `Container`, `RouteManager`, `ModuleLoader`, `ComponentManager`, `VelaApplication`, `bindAppProviders`). The same `bindAppProviders` that `VelaFactory.create` uses, so test-mode and run-mode app construction stay in lockstep automatically.

## HTTP transports and schema validation

Use the same response assertions against an existing remote Worker or an injected
fetch handler. Each client owns its headers; there is no global environment,
automatic cookie jar, implicit authentication, or request retry.

```ts
import { createTestHttpClient } from '@velajs/testing';

const remote = createTestHttpClient({ baseUrl: 'https://staging.example.com/' })
  .withHeaders({ authorization: 'Bearer test-session' });
(await remote.get('/health').send()).assertOk();

// A native Workers test can inject SELF.fetch using an explicit closure.
const native = createTestHttpClient({
  baseUrl: 'https://worker.test/',
  fetch: request => SELF.fetch(request),
});
(await native.get('/health').send()).assertOk();
```

`actingAs` needs a local `TestingModule`; remote clients use explicit headers.
`forHost` preserves the base URL scheme while replacing its host and Host header.
Relative paths resolve against `baseUrl` using standard URL rules.

`response.json(schema)` accepts Standard Schema v1, `defineDto` descriptors, and
legacy parsers (including `parseAsync`). It awaits validation and infers the
transformed output. The cached value remains the raw JSON: a later `json()` call
still returns `unknown`, and each requested schema runs against that original
value. Validator exceptions propagate; invalid payloads fail the test.

## License

MIT
