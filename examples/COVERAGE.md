# Example Coverage Matrix

This matrix tracks consumer-style examples. A feature is "runtime covered" only when a fake project installs the package with a `file:` dependency and exercises the feature through a real app, script, curl run, or Worker-style handler.

Status:

- `runtime` — covered by a standalone example project.
- `unit` — covered by package tests only.
- `planned` — needs a standalone example.
- `n/a` — type-only or constant export; runtime coverage is not useful by itself.

## Current Example Projects

| Project | Package(s) | Purpose | Runtime command |
|---|---|---|---|
| `examples/evergreen-market-api` | `@velajs/vela` via `file:../..` | Real product-catalog API covering core HTTP, DI, pipeline, and built-in modules | `pnpm --dir examples/evergreen-market-api dev` + `pnpm --dir examples/evergreen-market-api curl:test` |
| `crud/examples/harbor-crud-api` | `@velajs/crud`, `@velajs/vela` via `file:` | Real harbor inventory API covering generated CRUD resources and consumer install behavior | `pnpm --dir examples/harbor-crud-api dev` + `pnpm --dir examples/harbor-crud-api curl:test` |
| `testing/examples/lab-testing-harness` | `@velajs/testing`, `@velajs/vela` via `file:` | Real sensor-lab consumer tests covering module compilation, overrides, HTTP testing, and lifecycle | `pnpm --dir examples/lab-testing-harness test` |
| `cloudflare/examples/worker-bindings-lab` | `@velajs/cloudflare`, `@velajs/vela` via `file:` | Real Worker-shaped lab covering bindings, services, env, scheduled events, and queue consumers | `pnpm --dir examples/worker-bindings-lab test` + `pnpm --dir examples/worker-bindings-lab smoke` |
| `examples/di-playground-api` | `@velajs/vela` via `file:../..` | Real diagnostics API covering advanced DI/module exports, adapter helpers, logger, validation, and streaming | `pnpm --dir examples/di-playground-api dev` + `pnpm --dir examples/di-playground-api curl:test` |
| `examples/scheduler-node-jobs` | `@velajs/vela` and `@velajs/vela/schedule-node` via `file:../..` | Real Node scheduler job app covering interval, cron, executor registration, and timer cleanup | `pnpm --dir examples/scheduler-node-jobs test` + `pnpm --dir examples/scheduler-node-jobs smoke` |

## Planned Example Projects

No planned example projects remain in the current coverage plan.

## `@velajs/vela` Public Surface

| Feature / export group | Status | Covered by | Notes |
|---|---|---|---|
| `VelaFactory`, `VelaApplication` | runtime | `evergreen-market-api` | Server and tests create and use a real app |
| `Controller`, `Version`, `Get`, `Post`, `Put`, `Patch`, `Delete`, `Options`, `Head`, `All`, `Sse` | runtime | `evergreen-market-api/scripts/curl-all.sh` | All route decorators are hit with curl |
| `Param`, `Query`, `Body`, `Headers`, `Req`, `Res`, `Ip`, `Cookie`, `Cookies`, `RawBody`, `createParamDecorator` | runtime | `evergreen-market-api/scripts/curl-all.sh` | All parameter decorators are exercised through HTTP |
| `HttpCode`, `Header`, `Redirect`, `applyDecorators` | runtime | `evergreen-market-api` | Response status/header/redirect and composed scope decorator |
| `Injectable`, `Inject`, `Optional`, `InjectionToken`, provider `useValue`, `useClass`, `useFactory`, request `Scope` | runtime | `evergreen-market-api` | Includes request-scoped guard marker and optional provider |
| `Container` | runtime | `di-playground-api` | Route creates a container, registers a provider, and resolves it |
| `ForwardRef`, `forwardRef` | runtime | `di-playground-api` | Circular provider and circular module import paths covered |
| `ModuleRef` | runtime | `di-playground-api` | `get`, `resolve`, and `create` covered |
| `mixin` | runtime | `di-playground-api` | Parameterized role guards covered by curl |
| `Module`, dynamic modules via `forRoot`, `forRootAsync` | runtime | `evergreen-market-api`, unit tests | Built-in modules use dynamic module shape |
| `Global`, `createModuleRef` | runtime | `di-playground-api` | Global provider and dynamic module routes covered |
| `UseMiddleware`, `UseGuards`, `UsePipes`, `UseInterceptors`, `UseFilters`, `Catch` | runtime | `evergreen-market-api` | Controller and method levels exercised |
| `SetMetadata`, `Reflector` | runtime | `evergreen-market-api` | Scope guard reads route metadata |
| `APP_GUARD`, `APP_PIPE`, `APP_INTERCEPTOR`, `APP_FILTER`, `APP_MIDDLEWARE` | runtime | `evergreen-market-api` | Registered through module providers |
| `ParseIntPipe`, `ParseFloatPipe`, `ParseBoolPipe`, `ParseUUIDPipe`, `ParseEnumPipe`, `ParseArrayPipe`, `DefaultValuePipe`, `RequiredPipe` | runtime | `evergreen-market-api/scripts/curl-all.sh` | Success and one failure path covered |
| `ZodValidationPipe` | runtime | `di-playground-api` | Body validation route covered |
| `createZodDto`, `ValidationPipe` | runtime | `evergreen-market-api` | Create/replace product body validation |
| `Serialize`, `SerializerInterceptor` | runtime | `evergreen-market-api` | Product secret is stripped on read |
| `ConfigModule`, `ConfigService`, `CONFIG_OPTIONS` | runtime | `evergreen-market-api` | `/api/built-ins/config` |
| `HttpModule`, `HttpService`, `HTTP_MODULE_OPTIONS`, `HttpRequestException` | runtime/unit | `evergreen-market-api`, `src/__tests__/http-client.test.ts` | Success via data URL; exception paths unit-only |
| `CorsModule`, `CORS_OPTIONS` | runtime | `evergreen-market-api/scripts/curl-all.sh` | Origin response header checked |
| `CacheModule`, `CacheService`, `CacheInterceptor`, `MemoryCacheStore`, `CacheKey`, `CacheTTL` | runtime | `evergreen-market-api/scripts/curl-all.sh` | Manual cache and interceptor cache checked |
| `EventEmitterModule`, `EventEmitter`, `EventEmitterSubscriber`, `OnEvent` | runtime | `evergreen-market-api/scripts/curl-all.sh` | Event is emitted and subscriber log checked |
| `ScheduleModule`, `ScheduleRegistry`, `Cron`, `Interval`, `parseCron` | runtime/unit | `evergreen-market-api`, `src/__tests__/schedule.test.ts` | Registry covered at runtime; parsing unit-only |
| `HealthModule`, `HealthCheckService`, `HealthIndicatorService`, `HttpHealthIndicator` | runtime/unit | `evergreen-market-api`, `src/__tests__/health.test.ts` | Local health covered; HTTP ping details unit-only |
| `ThrottlerModule`, `ThrottlerGuard`, `ThrottlerStorage`, `Throttle`, `SkipThrottle` | runtime | `evergreen-market-api/scripts/curl-all.sh` | Limit and skip paths checked |
| OpenAPI: `createOpenApiDocument`, `ApiDoc`, `ApiTags`, `ApiResponse` | runtime | `evergreen-market-api` | `/openapi.json` checked |
| `zodToJsonSchema` | unit | `src/__tests__/zod-to-json-schema.test.ts` | Type conversion belongs in unit tests |
| `HttpException` and HTTP exception subclasses | unit/runtime partial | package tests, `evergreen-market-api` | Runtime covers `ForbiddenException`, `NotFoundException`, `BadRequestException`; rest unit-only |
| Lifecycle interfaces | runtime | `evergreen-market-api` | Init/bootstrap/shutdown checked |
| `MetadataRegistry`, `defineMetadata`, `getMetadata` | unit/runtime partial | package tests, decorators in examples | Direct consumer example not needed except plugin/internal cases |
| `Logger`, `LogLevel` | runtime | `di-playground-api` | Diagnostics route captures logger output with context |
| Hono adapter exports: `getRuntimeKey`, `env` | runtime | `di-playground-api` | Runtime helper route covered |
| `@velajs/vela/streaming` subpath | runtime | `di-playground-api` | `streamText()` route covered by curl |
| `@velajs/vela/schedule-node` subpath | runtime | `scheduler-node-jobs` | `ScheduleNodeModule` and `ScheduleExecutor` covered with fake timers and smoke |

## `@velajs/crud` Public Surface

| Feature / export group | Status | Covered by | Notes |
|---|---|---|---|
| `Crud` | runtime | `crud/examples/harbor-crud-api` | Create/list/read/update/delete, guard, DTO, and hook paths covered by tests and curl |
| `CrudModule` | runtime | `crud/examples/harbor-crud-api` | Dynamic `/api/berths` resource with guard and `only` filtering |
| `CrudService` | runtime | `crud/examples/harbor-crud-api` | Injected service exposes `meta` and `adapters` through `/api/meta/container-resource` |
| `Override` | runtime | `crud/examples/harbor-crud-api` | `@Override('list')` replaces `/api/container-reports` list route |
| `getOverrides` | unit | `crud/src/__tests__/override.test.ts` | Helper is not useful through a consumer HTTP route |
| `buildCrudRoutes` | unit/internal | `crud/src/__tests__/hooks.test.ts` | Consumer app should not call directly except advanced docs |
| `ALL_CRUD_ENDPOINTS`, `CrudConfig`, `CrudDtos`, `CrudHooks`, `CrudEndpointName`, `EndpointOverride`, `ResourceConfig` | n/a/runtime partial | type surface and `harbor-crud-api` config | Runtime behavior covered through `Crud` and `CrudModule` config |

## `@velajs/cloudflare` Public Surface

| Feature / export group | Status | Covered by | Notes |
|---|---|---|---|
| `createCloudflareApp`, `CloudflareApplication` | runtime | `cloudflare/examples/worker-bindings-lab` | Created from installed package; `fetch`, `scheduled`, `queue`, `getHonoApp`, and `close` paths covered |
| `KVModule`, `KVService` | runtime | `cloudflare/examples/worker-bindings-lab` | KV write/read routes through Worker `fetch` |
| `D1Module`, `D1Service` | runtime | `cloudflare/examples/worker-bindings-lab` | D1 prepared statement route |
| `R2Module`, `R2Service` | runtime | `cloudflare/examples/worker-bindings-lab` | R2 put/get routes |
| `QueueModule`, `QueueService` | runtime | `cloudflare/examples/worker-bindings-lab` | Queue producer route and queue consumer handler |
| `DurableObjectModule`, `DurableObjectService` | runtime | `cloudflare/examples/worker-bindings-lab` | Durable Object namespace/stub route |
| `AIModule`, `AIService` | runtime | `cloudflare/examples/worker-bindings-lab` | Mocked AI binding route |
| `VectorizeModule`, `VectorizeService` | runtime | `cloudflare/examples/worker-bindings-lab` | Mocked vector search route |
| `HyperdriveModule`, `HyperdriveService` | runtime | `cloudflare/examples/worker-bindings-lab` | Hyperdrive connection metadata route |
| `Env` | runtime | `cloudflare/examples/worker-bindings-lab` | Full env and specific binding injection |
| `Scheduled`, `QueueConsumer` | runtime | `cloudflare/examples/worker-bindings-lab` | Worker `scheduled` and `queue` handlers invoked directly |

## `@velajs/testing` Public Surface

| Feature / export group | Status | Covered by | Notes |
|---|---|---|---|
| `Test.createTestingModule` | runtime | `testing/examples/lab-testing-harness` | Used from installed `@velajs/testing` in a standalone project |
| `TestingModule` | runtime | `testing/examples/lab-testing-harness` | `get()`, `createApplication()`, and `close()` covered |
| `TestingModuleBuilder`, `OverrideBy`, overrides for provider/guard/pipe/interceptor/filter | runtime | `testing/examples/lab-testing-harness` | Covers `useValue`, `useClass`, `useFactory`, and HTTP component overrides |

## Next Build Order

The current package-level example plan is complete. Remaining gaps are intentionally unit-only, type-only, or negative/error subclasses that do not need standalone fake projects unless a release requires them.
