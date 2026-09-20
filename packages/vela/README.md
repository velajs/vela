# @velajs/vela

[![npm version](https://img.shields.io/npm/v/@velajs/vela)](https://www.npmjs.com/package/@velajs/vela)
[![CI](https://github.com/velajs/vela/actions/workflows/ci.yml/badge.svg)](https://github.com/velajs/vela/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@velajs/vela)](https://github.com/velajs/vela/blob/main/LICENSE)

NestJS-compatible framework for edge runtimes, powered by [Hono](https://hono.dev).

## Install

```bash
pnpm add @velajs/vela
```

See the [documentation index](https://github.com/velajs/vela/blob/main/docs/README.md)
for module authoring, runtime types, security, WebSockets, and live queries.

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

HTTP requests have a 1 MiB body ceiling plus bounded query size/count/depth by
default, enforced before application middleware, signed-body capture, guards,
and parameter parsing. Configure global and narrow streaming limits with
`VelaFactory.create(AppModule, { security: { body: ..., query: ... } })`.
Guards run before parameter decorators and pipes, and malformed JSON passed to
`@Body()` produces a 400 response. See the [security guide](https://github.com/velajs/vela/blob/main/docs/security.md)
for caching, signed URLs, browser headers, client identity, and WebSockets.

Rate limiting prefers identity explicitly published by trusted authentication
through `setTrustedRequestIdentity()` (principal plus verified tenant), then a
configured tracker, then the runtime-attested client address. Core never derives
a tracker from forwarding headers. Authentication guards must be registered
before `ThrottlerModule`.

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
- **CRUD integration** — Optional [`@velajs/crud`](https://github.com/velajs/vela/tree/main/packages/crud) package

## Edge Runtime Compatibility

Vela runs on any runtime that supports the Web Standards API:

- Cloudflare Workers
- Deno Deploy
- Bun
- Node.js 24+
- Vercel Edge Functions

No Node.js-specific APIs (`node:fs`, `Buffer`, `process`) are used.

### Edge-safe contract

The **main export** (`@velajs/vela`) is edge-safe by contract — no `node:*` imports, no `Buffer`, no `process`, no `setInterval`, no `Bun.serve`. This is enforced in CI by [`src/__tests__/edge-runtime-audit.test.ts`](src/__tests__/edge-runtime-audit.test.ts), which fails the build if any file under `src/` references a forbidden API.

One subpath, **`@velajs/vela/schedule-node`**, is an opt-in Node/Bun adapter for `setInterval`-based job execution. It uses runtime-specific APIs by design and is **excluded from the edge-runtime audit**. Edge runtimes (Cloudflare Workers, Deno Deploy, Vercel Edge) should not import it — use platform cron triggers instead (e.g., `@velajs/cloudflare` dispatches `@Cron` jobs via the Workers `scheduled()` handler).

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

Vela runs `middleware → guards → extract args/pipes → interceptors → handler`.
An ordinary `createParamDecorator` can read state populated by a guard. Its data
argument is required when the factory excludes `undefined`: a factory accepting
`string` produces `@Header('x-id')`; a factory accepting `undefined` supports
`@CurrentUser()`.

Use `createLazyParamDecorator` when a handler may not need an expensive value.
It injects a function the handler calls explicitly. The function caches the
returned value or Promise, or the thrown error, and never reruns the factory.
Primitives, `undefined`, objects and promises retain their real semantics.

```ts
import {
  createLazyParamDecorator,
  Injectable,
  REQUEST_CONTEXT,
  RequestContextKey,
  UseGuards,
} from '@velajs/vela';
import type { CanActivate, ExecutionContext } from '@velajs/vela';

const USER = new RequestContextKey<{ id: string; name: string }>('app.user');

@Injectable()
class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.getContainer()?.resolve(REQUEST_CONTEXT);
    if (!request) throw new Error('Missing request context');
    request.set(USER, { id: 'u-1', name: 'ada' });
    return true;
  }
}

const DeferredProfile = createLazyParamDecorator(
  (_data: undefined, context: ExecutionContext) =>
    context.getContainer()?.resolve(REQUEST_CONTEXT).get(USER),
);

@UseGuards(AuthGuard)
@Get('/me')
me(@DeferredProfile() loadProfile: () => { id: string; name: string } | undefined) {
  const profile = loadProfile();
  return { id: profile?.id };
}
```

For an async factory, annotate the injected parameter as `() => Promise<User>`
and call `await loadUser()`. Lazy decorators do not accept parameter pipes:
validate the produced value in the factory. Ordinary decorators continue to
accept pipes after their data argument.

## Companion packages

| Package | Purpose |
|---|---|
| [`@velajs/cloudflare`](https://github.com/velajs/vela/tree/main/packages/cloudflare) | Native Workers bindings, HTTP/queue/scheduled handlers, and Durable Object integrations |
| [`@velajs/crud`](https://github.com/velajs/vela/tree/main/packages/crud) | Schema-bound CRUD controllers with memory and Drizzle adapters |
| [`@velajs/testing`](https://github.com/velajs/vela/tree/main/packages/testing) | `Test.createTestingModule()` with `overrideProvider/Guard/Pipe/Interceptor/Filter` |

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
