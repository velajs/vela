# @velajs/testing

[![npm version](https://img.shields.io/npm/v/@velajs/testing)](https://www.npmjs.com/package/@velajs/testing)
[![License: MIT](https://img.shields.io/npm/l/@velajs/testing)](https://github.com/velajs/testing/blob/main/LICENSE)

Test-module builder for [Vela](https://github.com/velajs/vela). Compose modules in isolation, override providers/guards/pipes/interceptors/filters, and exercise controllers via Hono's `app.request()` — without bootstrapping the real factory.

## Install

```bash
pnpm add -D @velajs/testing
# Peer (already in your project): @velajs/vela ^1.1.0, hono ^4
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

```ts
.overrideGuard(AuthGuard).useValue({ canActivate: () => true })
.overrideInterceptor(LogInterceptor).useClass(NoopInterceptor)
.overrideProvider(CONFIG).useFactory({
  factory: (env: EnvService) => ({ env: env.getEnv() }),
  inject: [EnvService],
})
```

Inline providers (skip importing a module):

```ts
const moduleRef = await Test.createTestingModule({
  providers: [InlineService],
}).compile();
```

## HTTP testing

```ts
const moduleRef = await Test.createTestingModule({ imports: [ItemsModule] }).compile();
const app = await moduleRef.createApplication();

const res = await app.getHonoApp().request('/items');
expect(res.status).toBe(200);
expect(await res.json()).toEqual([{ id: 1, name: 'Item 1' }]);
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

## How it's wired

`@velajs/testing` consumes vela's framework primitives via `@velajs/vela/internal` (`MetadataRegistry`, `Container`, `RouteManager`, `ModuleLoader`, `ComponentManager`, `VelaApplication`, `bindAppProviders`). The same `bindAppProviders` that `VelaFactory.create` uses, so test-mode and run-mode app construction stay in lockstep automatically.

## License

MIT
