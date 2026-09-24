# @velajs/vela

[![npm version](https://img.shields.io/npm/v/@velajs/vela)](https://www.npmjs.com/package/@velajs/vela)
[![CI](https://github.com/velajs/vela/actions/workflows/ci.yml/badge.svg)](https://github.com/velajs/vela/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@velajs/vela)](https://github.com/velajs/vela/blob/main/LICENSE)

Nest-style modules, controllers, and dependency injection for edge runtimes, powered by [Hono](https://hono.dev).

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
export default app; // Fetch-compatible application
```

This example serves `GET /app/` and returns `{ "message": "Hello from the edge!" }`.

Build decorated TypeScript with legacy decorators and emitted decorator metadata,
for example with Vite 8, whose Oxc transformer emits both. See the
[tooling guide](https://github.com/velajs/vela/blob/main/docs/tooling.md)
and [API starter](https://github.com/velajs/vela/tree/main/apps/api-starter) for
working compiler and runtime configuration. For native Workers bindings, use
`createCloudflareWorker` from
[`@velajs/cloudflare`](https://github.com/velajs/vela/tree/main/packages/cloudflare).

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
a tracker from forwarding headers. Global guards run in fixed phases
(`authenticate`, `tenant`, `authorize`, `feature`), so authentication runs before
throttling whatever the import order.

## Features

- **Decorator-based controllers** — `@Controller`, `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`
- **Dependency injection** — `@Injectable`, `@Inject`, `InjectionToken`, `Scope.DEFAULT` (singleton), `Scope.TRANSIENT` and `Scope.REQUEST` scopes
- **Modules** — `@Module` with imports, exports, controllers, providers
- **Guards** — `@UseGuards` with `CanActivate` interface
- **Pipes** — `@UsePipes`, built-in `ParseIntPipe`, `ParseBoolPipe`, etc., and `ValidationPipe` from `@velajs/vela/validation`
- **Schema-validated parameters** — `@Body(schema)`, `@Query('page', schema)`, `@Param('id', schema)` return 400 on invalid input and document the schema in OpenAPI
- **Interceptors** — `@UseInterceptors` with `NestInterceptor` interface
- **Exception filters** — `@UseFilters`, `@Catch`, built-in HTTP exceptions; every failure renders through one `renderHttpError` as `{ error: { code, message, details? } }`, including a JSON 404
- **Middleware** — `@UseMiddleware` for Hono-native middleware
- **Custom metadata** — `@SetMetadata`, `Reflector.createDecorator()` and a `Reflector` that reads `context.getHandler()` / `context.getClass()` as in Nest
- **Custom param decorators** — `createParamDecorator`
- **Route versioning** — `@Controller({ path: '/users', version: 1 })` + `@Version(2)` (serves `/v1/users` and `/v2/users`), `VERSION_NEUTRAL`, and `versioning: { prefix }`
- **Global prefix** — `VelaFactory.create(AppModule, { globalPrefix: '/api', globalPrefixOptions: { exclude: ['health'] } })`, read back with `app.getGlobalPrefix()`
- **Request objects** — `@Req()` injects the platform `Request`, `@Ctx()` the Hono context
- **Server-Sent Events** — `@Sse()` streams an async iterable of `MessageEvent`
- **Lifecycle hooks** — `OnModuleInit`, `OnApplicationBootstrap`, `OnModuleDestroy`
- **CRUD integration** — Optional [`@velajs/crud`](https://github.com/velajs/vela/tree/main/packages/crud) package

## Import paths

Each name has exactly one import path.

| Entry | Contents |
|---|---|
| `@velajs/vela` | The application kit: `VelaFactory`, modules and DI, controllers and route/param decorators, guards, pipes, interceptors, filters, HTTP exceptions, `ConfigModule`, `Logger`, lifecycle types |
| `@velajs/vela/module-kit` | Seams for module, integration and adapter authors: `Container`, `MetadataRegistry`, `DiscoveryService`, entrypoint kinds and execution scopes, `PipelineRunner`, route contributors, `invokeScheduledJob`, module-authoring helpers |
| `@velajs/vela/cache`, `/throttler`, `/schedule`, `/events`, `/health`, `/logging`, `/http-client` | Optional feature modules |
| `@velajs/vela/openapi` | `OpenApiModule`, `createOpenApiDocument`, `@ApiDoc`/`@ApiTags`/`@ApiResponse`/`@ApiExclude` |
| `@velajs/vela/contract` | Browser-safe `defineRoute` contracts and the `ContractApp` client types |
| `@velajs/vela/security` | `SecurityModule`, `CorsModule`, `Secret`, signed-URL primitives, the nonce store |
| `@velajs/vela/dispatch` | Signed internal dispatch (`InternalDispatcher`, `@SignedInvocation`) |
| `@velajs/vela/validation`, `/websocket`, `/queue`, `/live`, `/i18n`, `/seeder`, `/storage`, `/streaming`, `/observability` | Validation and the other feature subsystems |
| `@velajs/vela/schedule-node`, `/websocket-node` | Node/Bun adapters |
| `@velajs/vela/internal` | Bootstrap plumbing for first-party tooling such as `@velajs/testing` |

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

WebSocket transports for Node, Bun, and Deno are exposed separately through
`@velajs/vela/websocket-node`. On Workers, use `@velajs/cloudflare` and its native
Durable Object entrypoint. See the [WebSocket guide](https://github.com/velajs/vela/blob/main/docs/websockets.md).

## Runtime environment and config

`ENV` is the framework-owned token for the environment a runtime hands the
application: bindings, variables and secrets, typed as `VelaEnv`. Core declares
`VelaEnv` empty and never reads a platform global; `@velajs/cloudflare` extends it
with the `Cloudflare.Env` that `wrangler types` generates and seeds `ENV` for each
Worker and Durable Object. Elsewhere, seed it yourself:
`VelaFactory.create(AppModule, { env })` (a Node entry may pass `process.env`), or
`Test.createTestingModule(metadata, { env })` in tests.

```ts
import { ConfigModule, Inject, InjectEnv, Injectable, Module, registerAs, type ConfigType, type VelaEnv } from '@velajs/vela';

// Declare what your runtime provides. On Workers, @velajs/cloudflare types
// VelaEnv from `wrangler types` instead.
declare module '@velajs/vela' {
  interface VelaEnv {
    DATABASE_URL?: string;
  }
}

export const database = registerAs('database', (env) => ({
  url: env.DATABASE_URL ?? 'sqlite::memory:',
}));

@Injectable()
class Reports {
  constructor(
    @InjectEnv() private readonly env: VelaEnv,
    @Inject(database.KEY) private readonly db: ConfigType<typeof database>,
  ) {}
}

@Module({ imports: [ConfigModule.forFeature(database)], providers: [Reports] })
class ReportsModule {}
```

`registerAs(namespace, env => config)` reads `ENV`; `ConfigModule.forFeature`
provides one namespace to the importing module, and `ConfigModule.forRoot({ load })`
registers several; both share one provider per namespace, so its factory runs
once. `ConfigService<T>` checks `get`/`getOrThrow` dot paths against the shape
you declare. `ENV` has no default: reading it where no runtime seeded one fails,
while framework readers inject it optionally. A string `URL_SIGNING_SECRET` in
`ENV` signs URLs and invocations when no explicit secret is configured. Values
come from outside the program, so validate what you read.

## Dynamic modules

Every configurable module exposes `forRoot` (sync) and `forRootAsync`
(DI-resolved). `forRootAsync` takes the module's structural options next to the
factory; the factory returns the rest:

```ts
@Module({
  imports: [
    CacheModule.forRoot({ ttl: 60 }),
    HttpModule.forRoot({ baseURL: 'https://api.example.com' }),
    ConfigModule.forRootAsync({
      inject: [ConfigLoader],
      useFactory: async (loader: ConfigLoader) => ({ config: await loader.load() }),
    }),
  ],
})
class AppModule {}
```

### Identity model

Each `DynamicModule` has an optional `key?: string`; the same `(class, key)` is
one instance, and different keys coexist. `defineModule` derives the key from a
module's structural options only, so most modules have one instance per class:

```ts
// The same configuration imported twice → one instance
imports: [CacheModule.forRoot({ ttl: 60 }), CacheModule.forRoot({ ttl: 60 })]

// A second configuration under the same key → bootstrap fails, whatever the
// diagnostics policy: neither import may run on the other's options
imports: [CacheModule.forRoot({ ttl: 60 }), CacheModule.forRoot({ ttl: 120 })]

// Two instances: give each its own key
imports: [
  CacheModule.forRoot({ ttl: 60, key: 'fast' }),
  CacheModule.forRoot({ ttl: 120, key: 'slow' }),
]
```

When a consumer module imports two instances that export the same token, the
resolver throws `MultipleProvidersFoundError` with both candidate ids. Import
only one, or use a per-instance accessor exposed by the module.

The same applies to per-feature clients: two features that each import
`HttpModule.forRoot({ baseURL })` with different settings give each its own
`key`. `key`, `lazy` and `isGlobal` never change the key or reach the options
token. A repeat with other options fails bootstrap even when its `global`
flag differs too; one with the same options and another `global` flag is
reported through the diagnostics policy. Build your own
modules the same way with `defineModule`; see the [module authoring guide](https://github.com/velajs/vela/blob/main/docs/modules.md)
for structural options, `referenceKey`, and the rest of the authoring contract.

## Custom parameter decorators with deferred resolution

Vela runs `middleware → guards → extract args/pipes → interceptors → handler`.
Controller and handler middleware runs only for its matched HTTP method and route,
including before/after `await next()` behavior. HEAD retains Hono's GET fallback;
HEAD-only middleware is skipped for ordinary GET requests. Request-scoped
controllers are resolved when the handler is invoked, after guards and pipes
succeed. Singleton construction and bootstrap lifecycle hooks are unchanged.
Pipeline component construction failures are reported before handler exception
filters render them; filters are resolved only when an error needs handling.
Controller-scoped and handler-scoped middleware, guards, pipes, interceptors,
and filters resolve asynchronous providers in their declaring module. Parameter
pipes use the same owner. Guard, pipe, interceptor and filter classes that a
module's classes reference need no `providers` entry: the module registers them
and builds each once per scope with its dependencies, as in Nest. Application-wide components retain their global scope. Middleware configured by a
module resolves in that module, including async providers. Pipes may implement
`transformAsync`; HTTP prefers it at awaited boundaries and otherwise calls
`transform`.

Every HTTP request, including adapter-mounted routes, owns one execution lifetime.
Inject `EXECUTION_LIFETIME` to register `defer(() => work())` or `waitUntil(promise)`.
Deferred callbacks start after the middleware/handler chain settles; disposal waits
for both managed work and response EOF, error, or cancellation. Native Workers
`waitUntil` retains asynchronous cleanup. HEAD responses cancel their untransmitted
body before cleanup; WebSocket upgrade responses retain their native fields.
`REQUEST_CONTEXT.request` captures the request after framework body-limit
normalization and before application middleware runs. Guards, controllers, and
adapters therefore use the same readable request and its trusted identity. The
context remains a snapshot; replacing the request later does not transfer identity.
Rejected bodies retain their original request context through reporting and cleanup.
An ordinary `createParamDecorator` can read state populated by a guard. Its data
argument is required when the factory excludes `undefined`: a factory accepting
`string` produces `@Header('x-id')`; a factory accepting `undefined` supports
`@CurrentUser()`.

Use `createLazyParamDecorator` when a handler may not need an expensive value.
It injects a function the handler calls explicitly. The function caches the
returned value or Promise, or the thrown error, and never reruns the factory.
Primitives, `undefined`, objects and promises retain their real semantics.

```ts
import { Injectable, REQUEST_CONTEXT, RequestContextKey, UseGuards } from '@velajs/vela';
import { createLazyParamDecorator } from '@velajs/vela/module-kit';
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
pnpm add @velajs/crud @velajs/crud-memory zod
```

## Advanced framework integration

Applications use the root application kit and the feature subpaths. Module,
integration and adapter authors also use `@velajs/vela/module-kit`: `Container`,
`MetadataRegistry`, `DiscoveryService`, entrypoint kinds, execution scopes,
`PipelineRunner` and route contributors. `ModuleRef` and `VelaApplication` are
part of the root. The [module authoring guide](https://github.com/velajs/vela/blob/main/docs/modules.md)
covers public discovery, entrypoint, and route integration APIs.

`@velajs/vela/internal` also exposes lower-level bootstrap and routing machinery,
such as `RouteManager`, `ModuleLoader`, `ComponentManager`, and `bindAppProviders`.
It is used by framework integrations such as `@velajs/testing`; these internals
can change independently of the public module-authoring contract.

## License

MIT

## Standard Schema and edge capabilities

See the [edge capabilities guide](../../docs/edge-capabilities.md) for asynchronous
validation, tenant admission, Cedar authorization, compound IDs, scoped cursors,
commit hooks, encryption, and backend guarantees.

## Asynchronous response caching

Use `ResponseCacheModule.forRoot({ namespace, store, scope, invalidation? })` and
`@CacheResponse({ ttl, tags })` for async memory/tiered/remote response caching.
Inject `ResponseCacheService` for scoped reads and post-commit invalidation.
The legacy `CacheService` API stays synchronous. See the
[caching guide](../../docs/caching.md) for trusted partitions, failure behavior,
expiry and distributed consistency guarantees.
