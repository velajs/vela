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
