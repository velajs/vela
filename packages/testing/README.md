# @velajs/testing

[![npm version](https://img.shields.io/npm/v/@velajs/testing)](https://www.npmjs.com/package/@velajs/testing)
[![License: MIT](https://img.shields.io/npm/l/@velajs/testing)](https://github.com/velajs/vela/blob/main/packages/testing/LICENSE)

Test-module builder for [Vela](https://github.com/velajs/vela). Compose modules in isolation, override providers/guards/pipes/interceptors/filters, and exercise controllers via Hono's `app.request()`. Testing uses the same bootstrap primitive as production so request scope and framework-global providers cannot drift.

## Install

```bash
pnpm add -D @velajs/testing
# Peer (already in your project): @velajs/vela >=1.21 <2, hono >=4
```

No `reflect-metadata` needed — Vela ships its own polyfill.

## Quick Start

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Test } from '@velajs/testing';
import { MetadataRegistry } from '@velajs/vela';
import { Injectable, Module } from '@velajs/vela';

@Injectable()
class CatsService {
  findAll() { return ['cat1', 'cat2']; }
}

@Module({ providers: [CatsService] })
class CatsModule {}

beforeEach(() => MetadataRegistry.clear());

describe('CatsService', () => {
  it('returns cats', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CatsModule],
    }).compile();

    expect(moduleRef.get(CatsService).findAll()).toEqual(['cat1', 'cat2']);
  });
});
```

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
  factory: (env) => ({ env: env.getEnv() }),
  inject: [EnvService],
})
```

Inline providers (skip importing a module):

```ts
const moduleRef = await Test.createTestingModule({
  providers: [InlineService, defineProvider(CONFIG, { useValue: { env: 'test' } })],
}).compile();
```

Import `defineProvider` from `@velajs/vela`. Factory dependency types come from the required `inject` tuple; use `inject: []` for factories without dependencies.

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

`runInRequestScope(callback)` creates a real framework request context, including typed `RequestContextKey` storage, and disposes its child container when the callback finishes.

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

## License

MIT
