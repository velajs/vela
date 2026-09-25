# @velajs/graphql

## 1.30.0

### Minor Changes

- b227d22: Build `GraphqlModule` on `defineModule`, adding `forRootAsync`: `path` and `imports` are structural (`GraphqlStructuralOption`) and the factory returns the schema, driver and field pipeline.
  
  **Behavior change:** each path is one module instance, and a path's controller and service token are shared by its registrations. Registering the same path again with different options fails bootstrap instead of mounting a second endpoint class.
  
  `path` defaults to `/graphql` and `imports` to `[]` as structural defaults, so `forRoot(options)`, `forRoot({ ...options, path: '/graphql' })` and `forRoot({ ...options, imports: [] })` are one configuration and mount one endpoint. Another `imports` list on the same path fails bootstrap.
- 3fc6f2b: The GraphQL endpoint carries `SkipGuardPhases(['authorize'])` from `@velajs/vela/module-kit`, because resolvers authorize each field: the global authorization guards whose class declares `static readonly skippable = true` (`PermissionGuard`, `RolesGuard` and `CedarGuard`, including Cedar's default deny) do not run on it. Authentication, tenant admission, throttling and the other global guards still run there.
  
  **Behavior change:** those authorization guards no longer run on the GraphQL endpoint, including one the application registers itself, such as `{ provide: APP_GUARD, useClass: RolesGuard }`, and an application guard that extends one without declaring `static override readonly skippable = false`. @velajs/graphql 1.29.0 ran every global guard on the endpoint. Authorize each field with the resolver's guards.
- f267c2f: The `Reflector` accepts Nest's targets as well as an execution context: `reflector.get(key, context.getHandler())`, `reflector.get(key, context.getClass())` and `getAll`/`getAllAndOverride`/`getAllAndMerge(key, [context.getHandler(), context.getClass()])`. A handler function reads the metadata of the method it is: `SetMetadata` records the method it decorates, the HTTP, WebSocket and GraphQL transports record the method each route calls when they register it, and every framework execution context records the method `getHandler()` returns, so a method an outer decorator wrapped keeps its metadata. A custom execution context records its handler with `MetadataRegistry.addHandlerMethod(handler, type, name)` from `@velajs/vela/module-kit`. In the list form, `[context.getHandler(), context.getClass()]` reads the method that class routes through the function, so metadata one controller puts on a method it inherits never applies to a sibling controller sharing the method. Alone, as in `reflector.get(key, context.getHandler())` or `[context.getHandler()]`, a function several controllers route with different metadata for the key cannot say which one it serves, so the read throws and points to the execution-context and list forms. A function one controller routes as several methods with different metadata, such as one wrapper function that replaces them, throws in the list form too; the execution context names the method. Plain arrays and plain objects count as equal metadata when their own properties are equal, including any non-index property an array carries, and any other value is compared by identity. `Reflector.createDecorator({ key?, transform? })` stores `transform(value)`, and readers are typed with the transformed value.
  
  **Behavior change:** `ExecutionContext.getHandler()` returns the handler method, as in Nest, instead of its name. The new `getHandlerName()` returns the name (or a framework host's marker symbol). Custom execution contexts implement both; code that used the handler name, such as a cache or throttling key, calls `getHandlerName()`. GraphQL field contexts report the resolver method. `Reflector.getAll()` returns one value per target, typed `Array<T | undefined>` (handler, then class, for an execution context), instead of a `[handler, class]` tuple type.
- f267c2f: Every HTTP failure renders through one function, `renderHttpError(error, { catalog?, redactServerBodies? })`, exported from `@velajs/vela` with `getErrorStatus(error)`. It returns `{ status, body, redacted }`. Controller handlers, Vela middleware, the last-resort Hono `onError`, unmatched routes, request limits, RPC and GraphQL all derive their status and body there. Exception filters run first where the edge has a pipeline: controller handlers and RPC procedures (their scoped and global filters), GraphQL resolvers (the provider's filters and the `GraphqlModule` field filters), and Vela middleware, unmatched routes and request limits (global filters). The HTTP edges and RPC then apply the application's `ExceptionHandler.render` hook. The last-resort Hono `onError`, which receives errors thrown by raw Hono middleware and routes, runs no exception filters but applies the `ExceptionHandler.render` hook before rendering.
  
  - An exception owns its wire shape through `toResponse()`, which returns `{ status, body }` (`HttpErrorResponse`). `HttpException` returns an object response verbatim, as before, so a health check's 503 still ships as written; a string response takes the canonical `{ error: { code, message, details? } }` body. Only exceptions the `HttpException` constructor built, including subclasses such as `CrudException`, own a response: the constructor brands them. Any other thrown object with a `toResponse()` is an unknown error, reported and answered with a redacted 500, so a third-party error cannot choose its own status or body. `CrudException` renders its `{ success: false, error }` envelope through `toResponse()` and keeps its human-readable `message`. Errors thrown by raw Hono middleware reach only `onError`, which redacts an owned 5xx body to its status title, as RPC frames do.
  - `HttpException` and each subclass accept `options` (`{ details, cause }`). A 4xx sends `details` as `error.details`; a 5xx sends neither its text nor its details. `getDetails()` reads them.
  - Unmatched routes answer a JSON 404 (`{ error: { code: 'not_found', message: 'Not Found' } }`), including Workers built with `createCloudflareWorker`, and oversized bodies a JSON 413 (`payload_too_large`). These and the query-limit 400s are not reported. As in Nest, global exception filters receive them (`NotFoundException`, `PayloadTooLargeException`, `BadRequestException`), and a filter's plain result keeps their status.
  - A Hono `HTTPException` with a 4xx status renders its message in the canonical body on every edge, including controller handlers, where @velajs/vela 1.30.0 answered a redacted 500; one built with its own `res`, such as an auth challenge, keeps that response and its headers. Any other status below 500 renders as a redacted 500 unless the exception has its own `res`.
  - GraphQL maps a field error's status from the shared renderer, so branded `VelaError`s, Hono `HTTPException`s with a 4xx status and exception-owned responses reach the same public codes (`FORBIDDEN`, `NOT_FOUND`, …) as `HttpException`s, where @velajs/graphql 1.29.0 answered `INTERNAL_SERVER_ERROR` for any error that was not an `HttpException`. An RPC failure frame carries only `{ code, message, status }`. When the rendered body has `error.code` and `error.message` (the canonical body, or an exception-owned 4xx body with that member, such as the CRUD envelope), the frame keeps the message and the code, or the status's code when that code is malformed; otherwise it sends the status's code and a generic message. A frame coded `internal` always carries the generic message, and a 5xx owned body is redacted first.
  
  **Behavior change:** validation failures from `ValidationPipe` and `@Body(schema)` answer `{ error: { code: 'bad_request', message: 'Validation failed', details: { issues } } }`, and `@Endpoint` input failures the same body with the message `'Endpoint input validation failed'`, instead of `{ statusCode, message, errors }`. The thrown `BadRequestException` carries the issues in `getDetails()`.
  
  **Behavior change:** an exception filter's result is sent with `getErrorStatus(error)`, the exception's status (`HttpException.getStatus()` or `VelaError.status`) when it is 400–599, else 500, instead of 200. Return `{ status, body }` (exactly those keys) to set the status explicitly, or a `Response`. A filter that returns `undefined` no longer sends an empty 204: the error falls through to the default renderer. RPC applies the same rules to the status it keeps: a filter's plain result, which @velajs/rpc 1.30.0 ignored (the error fell through to the application's `ExceptionHandler.render` hook and the default frame, with the error's own code and message), now ends the call with a failure frame carrying that status's code and a generic message (`RPC request failed` for a 4xx), and `ExceptionHandler.render` does not run for the error. Return `undefined` from the filter to keep the default frame.
  
  **Behavior change:** an RPC failure caused by an exception-owned 4xx body that has `error.code` and `error.message`, such as `CrudException`'s `{ success: false, error: { code, message } }` envelope or an `HttpException` built with `{ error: { code: 'locked', message: 'Record locked' } }`, now carries that code and message: a `CrudException` 404 answers `{ code: 'NOT_FOUND', message: <its message>, status: 404 }`, where @velajs/rpc 1.30.0 answered `{ code: 'not_found', message: 'RPC request failed', status: 404 }`. An `HttpException` with a string response keeps its message and the status's code, as before. Update clients that match RPC error codes. GraphQL clients now see the status's public code (`FORBIDDEN`, `NOT_FOUND`, …) for branded `VelaError`s and 4xx Hono `HTTPException`s instead of `INTERNAL_SERVER_ERROR`.
  
  **Behavior change:** the last-resort Hono `onError` now applies the application's `ExceptionHandler.render` hook to errors thrown by raw Hono middleware and routes; @velajs/vela 1.30.0's `onError` rendered them without calling it. Exception filters still do not run there.
  
  **Behavior change:** `HttpException.getRawResponse()` is removed. Override `toResponse()` to own an exception's response, and call `renderHttpError(error)` to map an error to another transport.

### Patch Changes

- 3fc6f2b: The storage HTTP controller and the GraphQL endpoint inject the Hono context with `@Ctx()`, because `@Req()` injects the platform `Request` from @velajs/vela 1.31.0.
- Updated dependencies [0b8c649]
- Updated dependencies [1011653]
- Updated dependencies [088f4d4]
- Updated dependencies [f267c2f]
- Updated dependencies [dfe925c]
- Updated dependencies [fd11d20]
- Updated dependencies [748e4f8]
- Updated dependencies [096e259]
- Updated dependencies [fd11d20]
- Updated dependencies [3418c55]
- Updated dependencies [fd11d20]
- Updated dependencies [d51dbb3]
- Updated dependencies [f267c2f]
- Updated dependencies [4a06057]
- Updated dependencies [f267c2f]
- Updated dependencies [1bfc1c1]
- Updated dependencies [f267c2f]
- Updated dependencies [f267c2f]
- Updated dependencies [1ef55ac]
- Updated dependencies [f267c2f]
- Updated dependencies [b227d22]
- Updated dependencies [2c92243]
  - @velajs/vela@1.31.0

## 1.29.0

### Minor Changes

- 4d0342b: Build on the tiered `@velajs/vela` entry points: module-author seams such as `Container`, `MetadataRegistry`, `DiscoveryService`, `PipelineRunner`, trusted request identity and entrypoint scopes come from `@velajs/vela/module-kit`, and features from their subpaths. The package's own exports are unchanged.
  
  **Behavior change:** this release requires the `@velajs/vela` release that introduces `@velajs/vela/module-kit` and the feature subpaths; upgrade both together. Application code that imported these framework names from the root moves them as follows (the `@velajs/vela` changelog lists every name):
  
  | Old import | New import | Examples |
  |---|---|---|
  | `@velajs/vela` | `@velajs/vela/module-kit` | `Container`, `MetadataRegistry`, `DiscoveryService`, `createDiscoverableDecorator`, `registerEntrypointKind`, `runInEntrypointScope`, `PipelineRunner`, `RuntimeAdapter`, `invokeScheduledJob`, `getRequestContainer`, `setTrustedRequestIdentity`, `resolveErrorReporter`, `lazyProvider`, `stableHash`, `defineMetadata` |
  | `@velajs/vela` | `@velajs/vela/cache`, `/throttler`, `/schedule`, `/events`, `/health`, `/logging`, `/http-client` | `CacheModule`, `ResponseCacheModule`, `ThrottlerModule`, `ScheduleModule`, `Cron`, `EventEmitterModule`, `HealthModule`, `LoggingModule`, `HttpModule` |
  | `@velajs/vela` | `@velajs/vela/openapi` | `Endpoint`, `defineEndpoint`, `createOpenApiDocument`, `ApiDoc`, `ApiTags`, `ApiResponse` |
  | `@velajs/vela` | `@velajs/vela/security`, `/dispatch` | `SecurityModule`, `CorsModule`, `signUrl`, `NONCE_STORE`; `InternalDispatcher`, `SignedInvocation` |
  | `@velajs/vela` | `@velajs/vela/validation`, `/websocket` | `ValidationPipe`, `defineDto`, `parseSchemaAsync`; `WebSocketGateway`, `WebSocketModule` |
  | `@velajs/vela/internal` | `@velajs/vela/module-kit` | `Container`, `MetadataRegistry` |

### Patch Changes

- Updated dependencies [4467619]
- Updated dependencies [7372d90]
- Updated dependencies [c101033]
- Updated dependencies [4d0342b]
  - @velajs/vela@1.30.0

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

### Patch Changes

- Updated dependencies
  - @velajs/vela@1.28.0

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/vela@3.0.0

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [b99d71a]
  - @velajs/vela@2.0.0

## 1.1.0

### Minor Changes

- 760677b: Add optional executable-schema GraphQL integration with typed provider bindings, owner-qualified field pipelines, operation-owned loaders, a bounded Yoga HTTP driver, portable schema comparison, and a native Workers example.

### Patch Changes

- 591b0c2: Validate GraphQL route paths with linear scans instead of a regex that could backtrack exponentially on long invalid input. Preserve root and literal ASCII path segments while rejecting empty segments, trailing separators, and disallowed characters.
- Updated dependencies [c6a43a6]
- Updated dependencies [bbe62d4]
- Updated dependencies [a6ef933]
- Updated dependencies [dae3654]
- Updated dependencies [77cca9e]
- Updated dependencies [b9f75f5]
- Updated dependencies [df47ea8]
- Updated dependencies [af019bf]
- Updated dependencies [6df1059]
- Updated dependencies [bdd90a1]
- Updated dependencies [8a3923f]
- Updated dependencies [c7d108b]
- Updated dependencies [1c7f635]
- Updated dependencies [636ffbc]
- Updated dependencies [54f8864]
- Updated dependencies [f49db45]
- Updated dependencies [4fde903]
- Updated dependencies [6a1b5b3]
- Updated dependencies [a95951a]
- Updated dependencies [9e82187]
- Updated dependencies [c5a3cb0]
- Updated dependencies [363fb71]
- Updated dependencies [de4e57e]
- Updated dependencies [0765aaa]
- Updated dependencies [6b7cf23]
- Updated dependencies [5205e58]
- Updated dependencies [ae45689]
  - @velajs/vela@1.25.0
