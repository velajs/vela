# @velajs/vela

[![npm version](https://img.shields.io/npm/v/@velajs/vela)](https://www.npmjs.com/package/@velajs/vela)
[![CI](https://github.com/velajs/vela/actions/workflows/ci.yml/badge.svg)](https://github.com/velajs/vela/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@velajs/vela)](https://github.com/velajs/vela/blob/main/LICENSE)

NestJS-compatible framework for edge runtimes, powered by [Hono](https://hono.dev).

## Install

```bash
pnpm add @velajs/vela
```

## Quick Start

```typescript
import { VelaFactory, Controller, Get, Module, Injectable } from '@velajs/vela';

@Injectable()
class AppService {
  getHello() {
    return { message: 'Hello from the edge!' };
  }
}

@Controller('/app')
class AppController {
  constructor(private appService: AppService) {}

  @Get('/')
  hello() {
    return this.appService.getHello();
  }
}

@Module({
  controllers: [AppController],
  providers: [AppService],
})
class AppModule {}

const app = await VelaFactory.create(AppModule);
export default app; // Works on Cloudflare Workers, Deno, Bun, etc.
```

## Features

- **Decorator-based controllers** — `@Controller`, `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`
- **Dependency injection** — `@Injectable`, `@Inject`, `InjectionToken`, singleton/transient/request scopes
- **Modules** — `@Module` with imports, exports, controllers, providers
- **Guards** — `@UseGuards` with `CanActivate` interface
- **Pipes** — `@UsePipes`, built-in `ParseIntPipe`, `ParseBoolPipe`, `ZodValidationPipe`, etc.
- **Interceptors** — `@UseInterceptors` with `NestInterceptor` interface
- **Exception filters** — `@UseFilters`, `@Catch`, built-in HTTP exceptions
- **Middleware** — `@UseMiddleware` for Hono-native middleware
- **Custom metadata** — `@SetMetadata` + `Reflector`
- **Custom param decorators** — `createParamDecorator`
- **Route versioning** — `@Controller({ version: '1' })` + `@Version('2')`
- **Global prefix** — `app.setGlobalPrefix('/api')`
- **Lifecycle hooks** — `OnModuleInit`, `OnApplicationBootstrap`, `OnModuleDestroy`
- **CRUD integration** — Optional [`@velajs/crud`](https://github.com/velajs/crud) package

## Edge Runtime Compatibility

Vela runs on any runtime that supports the Web Standards API:

- Cloudflare Workers
- Deno Deploy
- Bun
- Node.js 20+
- Vercel Edge Functions

No Node.js-specific APIs (`node:fs`, `Buffer`, `process`) are used.

### Edge-safe contract

The **main export** (`@velajs/vela`) is edge-safe by contract — no `node:*` imports, no `Buffer`, no `process`, no `setInterval`, no `Bun.serve`. This is enforced in CI by [`src/__tests__/edge-runtime-audit.test.ts`](src/__tests__/edge-runtime-audit.test.ts), which fails the build if any file under `src/` references a forbidden API.

One subpath, **`@velajs/vela/schedule-node`**, is an opt-in Node/Bun adapter for `setInterval`-based job execution. It uses runtime-specific APIs by design and is **excluded from the edge-runtime audit**. Edge runtimes (Cloudflare Workers, Deno Deploy, Vercel Edge) should not import it — use platform cron triggers instead (e.g., `@velajs/cloudflare` ≥ 0.2.0 dispatches `@Cron` jobs via the Workers `scheduled()` handler).

```ts
// Node / Bun only — opt-in
import { ScheduleNodeModule } from '@velajs/vela/schedule-node';
```

The other subpaths (`@velajs/vela/internal`, `@velajs/vela/streaming`) follow the main export's edge-safe contract.

## Dynamic modules

Configurable modules use `forRoot` (sync) and `forRootAsync` (DI-resolved):

```ts
@Module({
  imports: [
    CacheModule.forRoot({ ttl: 60 }),
    HttpModule.forRoot({ baseURL: 'https://api.example.com' }),
    ConfigModule.forRootAsync({
      useFactory: async (loader: ConfigLoader) => loader.load(),
      inject: [ConfigLoader],
    }),
  ],
})
class AppModule {}
```

### Identity model

Each `DynamicModule` has an optional `key?: string` that discriminates one instance from another. First-party modules derive `key: stableHash(options)` automatically inside `forRoot` — so the same options always dedup, and distinct options register as distinct instances:

```ts
// Same options → dedup (one CacheModule instance, ttl: 60)
imports: [
  CacheModule.forRoot({ ttl: 60 }),
  CacheModule.forRoot({ ttl: 60 }),
]

// Different options → two distinct instances coexist
imports: [
  CacheModule.forRoot({ ttl: 60 }),
  CacheModule.forRoot({ ttl: 120 }),
]
```

When a consumer module imports two instances both exporting the same logical token, the resolver throws `MultipleProvidersFoundError` with both candidate ids — resolve the ambiguity by importing only one, or use a per-instance accessor exposed by the module. Most apps with a single instance never hit this.

Custom modules can use the same pattern via the public helpers:

```ts
import { defineDynamicModule, stableHash } from '@velajs/vela';

class MyModule {
  static forRoot(options: MyOptions): DynamicModule {
    return defineDynamicModule({
      module: MyModule,
      key: stableHash(options),    // or pass an explicit key
      providers: [/* ... */],
      exports: [/* ... */],
    });
  }
}
```

`forRootAsync` callers should pass `key` explicitly when the same module needs multiple async instances — factories aren't structurally hashable.

## Custom parameter decorators with deferred resolution

Vela's argument resolver runs **before** guards (`extract args → guards → handler`). A custom parameter decorator built with `createParamDecorator` therefore observes any state populated by a guard as still empty — its factory has already fired by the time the guard runs.

When a parameter's value depends on guard output (a `REQUEST_CONTEXT`-stored user, a tenant resolved from a JWT, etc.), use `createLazyParamDecorator` instead. The factory does not run during argument extraction; it runs the first time the handler reads a property on the resolved value:

```ts
import {
  createLazyParamDecorator,
  Inject,
  Injectable,
  REQUEST_CONTEXT,
  Scope,
  UseGuards,
} from '@velajs/vela';
import type { CanActivate, ExecutionContext, RequestContext } from '@velajs/vela';

const USER_KEY = Symbol.for('app.user');

@Injectable({ scope: Scope.REQUEST })
class AuthGuard implements CanActivate {
  constructor(@Inject(REQUEST_CONTEXT) private readonly ctx: RequestContext) {}
  canActivate(_e: ExecutionContext): boolean {
    this.ctx.set(USER_KEY, { id: 'u-1', name: 'ada' });   // populated here
    return true;
  }
}

const CurrentUser = createLazyParamDecorator((_data, ctx: ExecutionContext) => {
  const reqCtx = ctx
    .getContext()
    .get('container')
    .resolve<RequestContext>(REQUEST_CONTEXT);
  return reqCtx.get(USER_KEY);
});

@UseGuards(AuthGuard)
@Get('/me')
me(@CurrentUser() user: { id: string; name: string }) {
  return { id: user.id };           // factory runs here, AFTER AuthGuard
}
```

The proxy short-circuits `then` on its `get` trap so `await value` returns the proxy itself rather than triggering eager resolution. Method results are auto-bound to the resolved real target, so detached method calls keep `this`. `JSON.stringify(value)` works after one access (the proxy implements `ownKeys` + `getOwnPropertyDescriptor`).

## Companion packages

| Package | Purpose |
|---|---|
| [`@velajs/cloudflare`](https://github.com/velajs/cloudflare) | Cloudflare Workers adapter — typed services for KV, D1, R2, Queues, DO, AI, Vectorize, Hyperdrive |
| [`@velajs/crud`](https://github.com/velajs/crud) | NestJS-style CRUD controllers on top of `hono-crud` |
| [`@velajs/testing`](https://github.com/velajs/testing) | `Test.createTestingModule()` with `overrideProvider/Guard/Pipe/Interceptor/Filter` |

```bash
pnpm add @velajs/testing -D
pnpm add @velajs/cloudflare @cloudflare/workers-types
pnpm add @velajs/crud hono-crud @hono/zod-openapi zod
```

## `/internal` subpath (for plugin authors)

Framework primitives — `MetadataRegistry`, `Container`, `RouteManager`, `ModuleLoader`, `ComponentManager`, `VelaApplication`, `bindAppProviders`, `APP_*` tokens — are exposed at `@velajs/vela/internal`. This is the stable target for plugin packages that need to reach below the public API.

```ts
import { MetadataRegistry, Container } from '@velajs/vela/internal';
```

The public root barrel still exports `MetadataRegistry` (used by tests for `clear()` between cases). Everything else lives at `/internal` only.

## License

MIT
