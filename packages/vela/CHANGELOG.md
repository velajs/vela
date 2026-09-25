# Changelog

## 1.33.0

### Minor Changes

- b7d0725: Enforce include allowlists and strict bulk mutation filters, run point-read hooks inside the read scope, and reject D1 mutations whose read policies require interactive transactions. Require transactional row locking for ETag resources and lock before validating If-Match to prevent concurrent lost updates.
  
  Remove nonfunctional relation cascade configuration and the CRUD cascade driver. Use database foreign keys for hard-delete actions or explicit transactional hooks for soft-delete propagation. Studio's CRUD source no longer advertises a cascade preview without database constraint metadata.
  
  Remove implicit Hono context arguments, process-global Logger configuration, and the ComponentManager interceptor alias. Use explicit @Ctx(), instance-owned logging or LoggingModule, and PipelineRunner.chainInterceptors.
- b7d0725: Remove obsolete contracts and backward-compatibility paths.
  
  Validation now requires Standard Schema or DTO descriptors. Decorated events require event definitions and use EventDispatcher; EventEmitter.emit always settles every matching callback. Remove token-only discovery, instance-based schedule views, ownerless entrypoints, disposed-container reuse, unmanaged scope finalization, and the `(.*)` middleware alias. Queue driver bind returns cleanup and enqueue after inline disposal rejects. Configure HTTP body caps through security.body.maxBytes.
  
  WebSocket clients must report admission with trySendRaw. Tiered caches require expiry-aware read/write methods; KV entries without expiry metadata miss. Aggregate specs use only aggregations, the default CRUD adapter can be undefined, and Studio discovers resources registered through Crud. Remove the Studio path alias, the mail envelope argument overload, the AI embedding resolver fallback, and the obsolete contentHash export.
  
  Storage encryption rejects invalid ciphertext; compression requires format metadata and a metadata-capable store.
  
  Update adapters, examples, tests, API snapshots and migration documentation to the current contracts.

## 1.32.0

### Minor Changes

- 9dea818: Upgrade the integrations released with this core together with it: `@velajs/cli` 1.32.0, `@velajs/cloudflare` 1.32.0, `@velajs/crud` 1.32.0, `@velajs/mail` 1.32.0, `@velajs/storage` 1.32.0, `@velajs/testing` 1.32.0, and `@velajs/studio` 1.32.0 with `@velajs/studio-host` 1.24.0 and `@velajs/studio-ui` 1.25.0. Their earlier releases declare `^1.31.0` peer ranges, which accept this core without a warning, but several do not work with it: `@velajs/crud` 1.31.0 fails at import because `@Crud()` calls the removed `@ApiResponse(status, options)` form, Studio and CLI 1.31.0 read the removed `ModuleDescription.isGlobal`, `vela client generate` from CLI 1.31.0 fails on a document with an array query parameter or a named query parameter that takes one value or repeated keys, which this core documents with `style: form` and `explode: true`, and OpenAPI and `vela client generate` document the POST routes of `@velajs/storage` 1.31.0 as 201 while they answer 200.
  
  The integrations released with this core, `@velajs/storage` 1.32.0 included, declare `^1.32.0` peer ranges on it, so a package manager reports a peer conflict when one of them is installed with core 1.31. Studio's optional Cloudflare and CRUD peer ranges also become `^1.32.0`, and Cloudflare's optional storage and testing peer ranges become `^1.32.0`. `@velajs/better-auth` and `@velajs/feature-flags` have no release with this core: their 1.31.0 releases, which the Cloudflare and Studio changelogs list under `Updated dependencies`, remain current.
- 524e422: `VelaFactory.createApplicationContext(AppModule, options)` creates a standalone application context, as Nest's `NestFactory.createApplicationContext`: the module graph with its providers, lifecycle hooks and entrypoints, and no HTTP routes. It uses the production bootstrap, so the graph, `ENV` and `configureContainer` behave exactly as in `VelaFactory.create`. It is initialized (`onModuleInit`, `onApplicationBootstrap`) before it resolves, and a failure disposes what was built and rethrows. Use it for scripts, custom runtimes and platform objects, such as a Cloudflare Durable Object, that inject providers or dispatch entrypoints without serving HTTP. The options are `env`, `diagnostics` and `configureContainer` (`VelaApplicationContextOptions`).
  
  - The returned `VelaApplicationContext` has `get(token, { strict })` (`ApplicationContextLookupOptions`), which looks the token up across the application, or with `strict: true` as the selected module sees it: its own providers, its imports' exports and global tokens, the visibility `ModuleRef` uses. Nest's strict lookup differs: it finds only the providers the selected module declares itself, so a Vela strict lookup also returns an imported or global provider where Nest throws. `resolve(token, scope?, { strict })` awaits async factories, constructs transient providers anew and resolves request-scoped ones in the execution scope passed. `select(Module | DynamicModule)` returns a context over one module instance that shares the application's lifecycle; a module imported under several keys is selected by its `DynamicModule`. `init()` is idempotent. `close()` runs the shutdown hooks, and `dispose()` also releases the container. `entrypoints`, `getContainer()` and `materializeLazyModules()` are available as on an application.
  - `VelaApplication` extends `VelaApplicationContext`, as Nest's `NestApplication` extends its context, so an application also has `select()`, `resolve()`, `init()` and `get(token, { strict })`. `finalizeApplicationContext` joins `finalizeApplication` on `@velajs/vela/internal`.
- a7d0912: `ErrorReportContext.edge` accepts `'durable-object'`, `'workflow'`, `'email'` and `'tail'`: the edges on which Cloudflare Durable Objects, Workflow runs, Email Workers messages and Tail Workers events report failures.
  
  **Behavior change:** `ErrorReportContext.edge`, which an `ExceptionHandler`'s `report()` and `context()` receive, lists these four edges; a handler that switches exhaustively over `edge` must handle them.
- ff98301: Module descriptions name their visibility flag `global`, as `ModuleMetadata` (`@Global()`) and `DynamicModule` do.
  
  **Behavior change:** `ModuleDescription.isGlobal` (from `Container.getModuleDescriptions()`, `@velajs/vela/module-kit`) is removed; read `ModuleDescription.global`. The internal `ModuleScope.isGlobal` passed to `Container.registerScope()` (`@velajs/vela/internal`) is renamed `global` too. `vela module graph --json` and the `vela mcp serve` `module_graph`/`token_describe` results report `global` instead of `isGlobal`. The Studio wire protocol moves to version 4 (`STUDIO_PROTOCOL_VERSION`): `app.modules` rows carry `global` instead of `isGlobal` (`ModuleNode.global` in `@velajs/studio-protocol`), so upgrade `@velajs/studio`, `@velajs/studio-host` and `@velajs/studio-ui` together (a host or UI on protocol 3 refuses a protocol-4 application, and the reverse). Studio and CLI 1.31.0 read `isGlobal` and accept core 1.32.0 through their `^1.31.0` peer ranges without a warning: the CLI then reports no module as global, and Studio sends module rows without the `isGlobal` field its protocol-3 UI requires, so upgrade `@velajs/cli` and `@velajs/studio` to 1.32.0 with the core. The `isGlobal` registration extra of `forRoot()` options is unchanged.
- 38ab1e5: Routes declare their HTTP contract on the method decorator. `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Options`, `@Head` and `@All` take options after the path, or instead of it: `response` (a Standard Schema, `parse()` parser or `defineDto` descriptor), `status`, `format` (`json`, `text`, `binary`, `stream`, `response`), `contentType`, `validate` and `body`. The route parses the handler's final result, after interceptors, through `response` — a stripping schema removes undeclared fields, and a result the schema rejects answers the redacted 500 — documents it in OpenAPI and types generated clients; a handler whose return type does not match fails to compile, and a handler may always return a ready `Response`. Method decorators with `response` or `format` return `RouteMethodDecorator<Result>`, which checks the handler's result and is not assignable to `MethodDecorator`; annotate wrapper helpers with `RouteMethodDecorator<T>` or let them be inferred. Decorators without those options remain `MethodDecorator`s. `@CacheResponse` stores the response the route sent — its status, media type and body, after every interceptor and the schema — so a cache store never holds fields the schema strips, and a hit replays it without running the handler or parsing again; interceptors outside `CacheInterceptor` receive the replayed `Response`; a value they return instead of a `Response` is ignored, and a `Response` they return is sent. Change the cache `namespace`, or invalidate, when a tightened `response` schema must apply before entries expire. Without `response` or `format`, a route sends strings as text and other values as JSON, as a route without options does. Each route of a handler takes its status from its own options, and OpenAPI describes each success status with its reason phrase. `@Redirect` and `@Sse` combine with options that declare only the request (`body`, `name`). `@Body(schema)`, `@Query(schema)`, `@Param(name, schema)` and `@Headers(name, schema)` keep validating request values. A controller that routes a method it inherits unchanged (`Get()(Sub.prototype, 'list', descriptor)`) without options of its own serves it with those of the nearest ancestor's route for the same verb (its `response`, `status` or `defineRoute` contract), and the route reads the parameters the ancestor declares on the method (`@Body()`, `@Query()`, `@Param()` and the rest, with their emitted types), in responses and OpenAPI alike; a method the controller overrides uses only its own.
  
  The new browser-safe `@velajs/vela/contract` entry exports `defineRoute({ method, path, params, query, body, json | form | multipart, response, status, format })`, which imports no server code. Every method decorator serves a contract of its own method (`@Post(createTodo)`, `@Get('/:id', findTodo)`). A route that serves a contract fails to start with `@HttpCode`; declare `status` in the contract, which types its `ContractApp` clients. Declared means enforced: the route validates each request group its contract declares, and the body's encoding and limits, once per request after guards and before the handler, whether or not a parameter reads it; `@Body()`, `@Query()` and `@Param()` read the validated values, and a `ValidationPipe` does not validate them again. The application fails to start when the contract's `path` is not the path the route serves, when a `params` schema leaves out a path parameter the route serves, when a named parameter reads a key its group's schema does not return, or when a parameter adds its own schema to a declared group or is typed with a class whose static schema is not the group's (the route's schema replaces it; type the parameter with `ContractBody`, `ContractQuery` or `ContractParams`). The key checks need a schema that lists its keys as JSON Schema without passing undeclared keys through, as a Zod object does, even with fields JSON Schema cannot express. For any other, such as a Valibot schema, a `parse()` parser, a union or a transform that renames keys, a named parameter that reads a key the request carries but the validated value lacks fails that request with a 500 whose reported error names the key, as does a whole `@Param()` whose validated params lack a path parameter the request carries. The validation ships with `@Body`, `@Query` and `@Param`: a Worker bundle that uses none of them leaves it out, and a route declaring request groups or a form body then fails to start with an error saying so. `ContractApp<typeof routes>` types an `hc` client from contracts alone, `contractFormEncodings(routes)` lists the form encodings `withFormEncoding` needs to send `form:` contracts URL-encoded, and `ContractBody`, `ContractQuery`, `ContractParams` and `ContractResponse` type handlers. A contract and the equivalent decorator options produce the same OpenAPI document and the same `vela client generate` output. OpenAPI documents a request field JSON Schema cannot express, such as `z.coerce.date()`, as any value and lists the fields beside it; a `params` or `query` schema it cannot describe as an object (a Valibot schema without a JSON Schema converter, a union) documents the served path parameters as strings and marks the query unsupported by client generation, as a whole `@Query(schema)` with such a schema does, instead of failing the whole document.
  
  Routes read JSON by default (415 for other media types). A route opts into a form body with `body: { multipart: limits }` or `body: { form: limits }` (`multipart:` / `form:` on a contract), with `maxBytes`, `maxFields`, `maxFieldBytes`, `maxFiles` and `maxFileBytes`; `body: { json: { maxBytes } }` bounds a JSON route. A route that declares a body — its encoding, or a contract's `body` schema, which reads JSON within the application's limit — reads it after guards and before the handler, whether or not a parameter reads it. A body whose `Content-Length` exceeds the route's limit answers 413 before guards; any other body is read after guards, counting received bytes and cancelling at the limit, also under a matching `security.body.streamingOverrides` entry, so the framework buffers nothing before guards (middleware that reads the body reads it when it runs, within the same limit); every entry is measured before any field is interpreted, so oversized bodies, files or fields and too many files or fields answer 413, while unknown, repeated and mistyped fields answer 400 when a whole-body schema describes the fields as JSON Schema (without one, any field is accepted and a repeated name arrives as an array); a field JSON Schema cannot express, such as `z.coerce.date()` or `z.instanceof(File)`, receives its text or file as sent, for its schema to check, and leaves the checks on the fields beside it; a wrong media type answers 415. `z.file()` fields arrive as native `File` values, and text fields are validated and transformed by the body schema. Multipart defaults to one file of 1 MiB and a body of `maxFiles × maxFileBytes` plus 1 MiB. A route's own `maxBytes` replaces the application's body limit for that route, so an upload route needs no `security.body.streamingOverrides` entry (an override still takes precedence); a default `maxBytes` never exceeds a body limit the application configures. A body the route has read stays readable through `@RawBody()` or `c.req`, but not through the platform `Request` `@Req()` injects, whose stream the route consumed (reading it answers 500). OpenAPI documents the encoding, field encoding and `x-vela-body-limits`, the limits the route declares: the document is built from the module, so a default `maxBytes` appears without the cap of a smaller `security.body.maxBytes` the application sets; declare `maxBytes` on the route for the document to state the limit it enforces.
  
  `@Query()` and `@Query(name)` return keys a query schema declares as arrays in its JSON Schema (in any member of a union) as arrays even when sent once; other keys stay strings, so a repeated scalar fails its schema. A field JSON Schema cannot express, such as `z.coerce.date()` or `z.custom()`, does not stop the fields beside it from being read as declared. A schema that cannot describe itself as JSON Schema, such as a Valibot schema without a converter or a `parse()` parser, receives an array only for a repeated key. The schema is the route's, the parameter's own, or the parameter class's static schema. OpenAPI documents array query parameters with `style: form` and `explode: true`, and a named parameter without a schema that receives one value or repeated keys — declared `unknown`, a union, or an array a pipe such as `ParseArrayPipe` splits — as `oneOf` a string or a string array, which `vela client generate` types `string | Array<string>`.
  
  `@Body()` with no schema validates a parameter class that carries a static schema — a Standard Schema, a `defineDto` descriptor or a `parse()` parser, as `ValidationPipe` reads it (`class CreateTodo { static schema = z.object(…) }`) — or that is itself a Standard Schema, with no global pipe: the whole body, or the member a named `@Body('item')` reads. It validates as the body is read, before any pipe, unless a `ValidationPipe` (or a subclass) applies to the parameter — its own, or a global, controller or method pipe, a pipe class the module provides as one included; then that pipe validates it at its place in pipe order, as in Nest, and every `ValidationPipe` that applies validates. A validation pipe that is not a `ValidationPipe` runs after, on the validated value; extend `ValidationPipe` to take the class over. The class is read from the parameter's reflected type, so an `import type` or a union annotation such as `Dto | undefined`, which reflect as `Object`, leaves the body unvalidated; import the class as a value and annotate with it alone, or declare `@Body(schema)` for security-relevant bodies. Body parameters without a route reader, such as programmatic routes, are still validated by the global pipe.
  
  `defineSerializer` returns a Standard Schema from the domain input to the wire output, so it serves as a route's `response` and documents its output schema. `standardJsonSchema` and `zodToJsonSchema` take `libraryOptions` for the schema library's converter.
  
  The root entry exports the route option types for wrappers (`HttpMethodDecorator`, `RouteResponseOptions`, `RouteBodyOptions`, `RouteJsonBody`, `RouteFormBody`, `RouteMultipartBody`, `RouteHandlerResult` and `RouteSchemaResult`), and `@velajs/vela/contract` exports the contract types (`RouteContract`, `RouteContractMethod`, `ContractInput`, `ContractOutput`, `ContractEndpoint`, `ContractSchema`, `ContractStatus` and `ContractFormEncoding`).
  
  The minimal `VelaFactory.create()` Worker (one controller, bundled by Wrangler with `--minify`) measures 137,565 bytes raw and 46,635 bytes gzipped in this release, against 130,315 and 43,658 for 1.31.0, mostly route contracts and the application context, within its unchanged size budget.
  
  **Behavior change:** a routed inherited method now receives the parameters its ancestor declares on the method, and serves the ancestor route's options when it declares none, instead of receiving the Hono context and sending its result without them.
  
  **Behavior change:** `@Endpoint`, `defineEndpoint` and their types (`EndpointDefinition`, `EndpointSchema`, `EndpointRequest`, `EndpointHandlerOutput`, `EndpointBodyOptions`, `EndpointBodyContract`, `EndpointFormLimits`, `EndpointFormField`, `EndpointResponseFormat`, `EndpointResponseOutput`, `EndpointBinaryBody`) are removed from `@velajs/vela/openapi`. Declare `@Post({ response: Output, status })` with `@Body(json)`, `@Query(query)`, `@Param(name, schema)` and `@Headers(name, schema)` parameters instead of one `input` object, or a `defineRoute` contract to share with a client. `body: { contentType: 'multipart/form-data', …limits }` becomes `body: { multipart: limits }`, `'application/x-www-form-urlencoded'` becomes `body: { form: limits }`, and native endpoint formats become the `format` and `contentType` route options (`RouteResponseFormat`, `RouteBinaryBody`). Multipart defaults change from 10 files within a 1 MiB body to one file of 1 MiB within a body of `maxFiles × maxFileBytes` plus 1 MiB, so a converted upload route that relied on the defaults answers 413 for a second file; declare `maxFiles` (and `maxBytes`) to keep the earlier limits. Request values a route contract rejects answer the canonical validation body, `{ error: { code: 'bad_request', message: 'Validation failed', details: { issues } } }`, as `ValidationPipe` failures do, where `@Endpoint` input failures carried the message `'Endpoint input validation failed'`.
  
  **Behavior change:** `@Serialize`, `SerializerInterceptor`, `SERIALIZE_METADATA` and `SerializationDescriptor` are removed. Declare `@Get({ response: dto })` instead; the response is parsed as a whole, so use `z.array(item)` where `@Serialize` parsed each array element. A `defineSerializer` result no longer has a `.schema` property; pass the serializer itself as `response`.
  
  **Behavior change:** `@Query()` without a schema returns repeated keys (`?tag=a&tag=b`) as arrays instead of the first value. A named `@Query(name)` without a schema follows its declared type: a `string`, `number` or `boolean` parameter still receives the first value, an array parameter without a pipe always receives an array (OpenAPI documents it as one), and an `unknown` or union parameter (`string | undefined` and `string | null` included; write `role?: string` for the first value) receives an array for a repeated key. Declare a schema, or `ParseArrayPipe`, for values that may be one or many. `@Query(schema)` and `@Query(name, schema)` receive a key their schema declares as a scalar as an array when it is repeated, so the schema answers 400 where the first value used to pass; declare the field as an array, or send the key once.
  
  **Behavior change:** `@CacheResponse` stores the response a route sent under a new address and entry format, so entries an earlier release stored, which held the handler's raw result, miss once instead of being sent unparsed. On a hit, interceptors outside `CacheInterceptor` receive the replayed `Response` rather than the cached value; a value they return instead of a `Response` is ignored, and a `Response` they return is sent. Headers the skipped handler set per request are not replayed. This has a security consequence: an entry now includes what interceptors outside `CacheInterceptor` did for the request that stored it, and they no longer redo it on each hit. An interceptor there that shapes the response per viewer (removing fields by role, localizing) has its output for the first viewer replayed to every request in the same cache scope. Make the cache `scope` partition by everything the handler or any interceptor varies the response on, or leave such routes uncached. `shouldCache` receives the body the route sends, JSON-decoded (or its text), instead of the handler's value, so it no longer sees fields the `response` schema strips. As before, a fallback an interceptor outside `CacheInterceptor` sends when the call inside it throws or has not settled (error recovery, a timeout default) is not stored, while a value an interceptor inside it returns — a controller or method interceptor, or a global one registered after `CacheModule`'s — is that call's result, a fallback for a failed handler included, and is stored.
  
  **Behavior change:** `@Body()` with no schema validates a parameter class carrying a static schema (a Standard Schema, a `defineDto` descriptor or a `parse()` parser) even without a global `ValidationPipe`, so bodies that class rejects answer 400 instead of reaching the handler. A global validation pipe of your own that is not a `ValidationPipe` then receives the validated value, which fails for schemas whose transforms do not accept their own output: extend `ValidationPipe`, or remove the pipe.
  
  **Behavior change:** `@ApiResponse(status, options)` becomes Nest's `@ApiResponse({ status, description, schema })`, and `schema` is a Standard Schema or `defineDto` descriptor, converted to JSON Schema; raw JSON Schema objects are rejected when the decorator runs. `ApiResponseOptions` carries the `status` (a number, a range such as `'4XX'`, or `'default'`), and `ApiResponseEntry` is `ApiResponseOptions`. Declare a route's success body with its `response` option; an `@ApiResponse` for the success status only describes it. `@velajs/crud` 1.31.0 calls `@ApiResponse(status, options)` when `@Crud()` decorates a class, so it fails at import on this core; upgrade it to 1.32.0.
  
  **Behavior change:** OpenAPI describes a route's success response with its status's reason phrase (`Created` for 201, `No Content` for 204) instead of `OK` for every status.
- 38ab1e5: One rule decides every route's success status, shared by responses, OpenAPI, generated clients and the response cache: `@HttpCode`, else the route's `status` option, else 204 for `response: null`, 201 for POST and 200 for every other method. Declaring both `@HttpCode` and `status` fails at startup. A handler that returns a ready `Response` (`c.json()`, `new Response()`) sends that Response's own status; OpenAPI and generated clients still document the rule's status.
  
  **Behavior change:** a POST route answers 201, as in Nest, instead of 200, and OpenAPI and `vela client generate` document 201. Add `@HttpCode(200)` (or `status: 200`) to a POST route whose clients expect 200. A POST handler that returns a ready `Response` keeps answering its status (200 for `c.json(body)`), but is now documented as 201: declare `@HttpCode(200)` or `status: 200` on it too, so the document matches what it sends.
  
  **Behavior change:** a handler returning `null` or `undefined` no longer answers 204; it answers the route's status with an empty body. Declare `response: null` or `@HttpCode(204)` where clients expect 204.
- e412fc8: The default in-memory `ThrottlerStorage` keeps each key's counter until its own window (`ttl`) ends. It used to swap its maps every 60 seconds and drop a key untouched for one to two minutes, so a throttler with a longer window (`ttl: 600_000`, say) reset early and let a client exceed its limit. Ended windows are evicted. The store tracks at most `maxKeys` open windows (default 50,000), configured per application with `storage: () => new ThrottlerStorage({ maxKeys })`; its options type is `ThrottlerStorageOptions` from `@velajs/vela/throttler`. A key is one route, throttler and client (`ThrottlerGuard` joins the controller, handler, throttler name and tracker), so size `maxKeys` as distinct clients per longest `ttl`, times the routes each one calls, times the throttlers (see docs/security.md).
  
  **Behavior change:** when `maxKeys` windows are open, the default store answers 429 to a request with a new key until the earliest window ends, and the first refusal logs a warning; a live counter is never evicted, since that would reset its client's limit early. Previously the store never refused: it forgot counters instead. A client that already has a counter is counted as before. Raise `maxKeys` for the traffic of the longest window, keep in-memory windows short, or count long ones in a shared `ThrottlerStore`.
- bcdf5e3: `trackResponseStream(body, onFinish?)` from `@velajs/vela/module-kit` tracks the transmission of a response body, as the HTTP edge does: send the returned `body` in place of the original, and `done` resolves once it was read to the end, failed or was cancelled (after the producer's cancellation settles), with the outcome passed to `onFinish`. Runtime adapters pass `done` to `ExecutionScope.finish()` to keep an invocation's request-scoped providers and managed work alive while a streamed response is sent; Cloudflare Durable Object hosts use it for `fetch()`.
- d5a8c60: WebSocket hardening:
  
  - A gateway serves the `@SubscribeMessage()` handlers an ancestor class declares on methods it inherits unchanged, as in Nest and like the other declarations a class inherits. Its own declaration of an event wins, and a method it overrides without the decorator is not a handler.
  - The message of the `AggregateError` a multi-room `Gateways` push rejects with shortens each room id it names to 32 characters, so it stays bounded whatever the ids (still the first ten rooms, then how many more); each entry of `errors` names its room in full.
  
  **Behavior change:** a gateway handles the events an ancestor class declares with `@SubscribeMessage()` on methods the gateway inherits unchanged, through the guards, pipes, interceptors and filters that apply to those methods. Previously only the gateway's own declarations were handlers, and those events were ignored like any unknown event. Override such a method without the decorator, or remove the declaration from the ancestor, where a gateway must not serve it.
  
  **Behavior change:** a gateway whose module sees two or more `WS_SERVER` providers fails bootstrap, naming each providing module, also when they all come from `WebSocketModule` instances it imports. Previously several `WebSocketModule` instances were accepted and the server of whichever dispatcher connected the gateway first served it. Import one `WebSocketModule` instance in the gateway's module, or provide `WS_SERVER` in the gateway's module itself.

### Patch Changes

- 04e7ac5: A Hono `HTTPException` thrown past Vela's pipeline (from raw Hono middleware) with a fractional 4xx status, such as `404.5`, or a `NaN` status renders as a redacted 500 and is now reported first, like any other server fault. The raw `onError` edge used to skip reporting both, and the default reporter muted a fractional 4xx status as a client fault; both now treat only integer statuses from 400 to 499 as client faults. Other statuses the edge cannot answer, such as `302` or `700`, were already reported.
- 9c1bd0b: A module class that implements `NestModule` is now built, and its `configure(consumer)` called, once the whole module graph is registered, so `configure()` also sees providers from modules loaded after it, such as a global module imported later. The internal `bootstrap()` (`@velajs/vela/internal`) takes a `prepareGraph(container)` hook (`BootstrapInternals`) that changes the registered graph before any module class is built; `@velajs/testing` 1.32.0 applies its provider overrides and `useMocker` there.
  
  `OpenApiModule` documents the controllers the application serves, in the order the root module declares them, instead of re-reading the root module's static metadata: after `overrideModule(Module).useModule(Replacement)`, the served document describes the replacement's routes instead of the replaced module's.

## 1.31.0

### Minor Changes

- 0b8c649: A bare import of a generated module class that has no `@Module()` of its own, such as `imports: [CedarModule]` instead of `CedarModule.forRoot({ ... })`, now always fails bootstrap with `CedarModule is not a module: import CedarModule.forRoot(...) or CedarModule.forRootAsync(...) instead of the bare class, which configures nothing` (`register(...)`/`registerAsync(...)` for a `ConfigurableModuleBuilder` class). Previously, once any configured definition of the class had loaded in the process, in the same application or an earlier bootstrap, a bare import booted silently with none of the module's providers and without the global guard it installs. A bare import names a module only when the class declares `@Module()`: a class that carries only `@Global()` (which on a generated class makes its configured instances global) and the class of a hand-written `DynamicModule` without `@Module()` fail the same way, a generated class with the message above and any other class with `X is not a module. Add @Module() decorator to the class.` A generated class that declares `@Module()` itself is still imported bare, as before.
  
  **Behavior change:** a bare import of a class without `@Module()` fails bootstrap whatever was imported before it. Previously, a hand-written `DynamicModule` class without `@Module()`, imported configured at the root and then bare in a feature module under the default key, deduplicated to the configured instance, because the module check ran after the repeat check. Add `@Module({})` to the class, or import the configured definition (`Feature.forRoot(...)`, or the `DynamicModule` the class returns) instead of the bare class.
- 1011653: Bindings are referenced by name and resolved from each application's `ENV` when used. `@velajs/vela/module-kit` adds the seam: `BindingRef` (`{ binding: 'CACHE' }`), `BindingKind` (what a binding is and the configuration key that declares it), `resolveBinding(env, ref, kind)`, `defineBinding(kind)` for lower-camel binding factories, the `EnvFactory<T>` type for option values an application builds from its own `ENV`, and `readEnv(container)` for module providers. A missing binding fails with `ENV.CACHE is not set: declare the KV namespace binding 'CACHE' under kv_namespaces …`; a binding of another kind fails naming the same key.
  
  `@velajs/cloudflare` exports the Workers binding factories built on it: `kv`, `r2`, `d1`, `queue`, `durableObject` and `rateLimit`. `kv({ binding: 'CACHE' })` reads no environment when declared; calling it with an application's `ENV` returns the typed native binding. The Cloudflare Queues driver and the Worker's gateway room objects (WebSocket upgrade forwarding, `Gateways` pushes, `durableObjectLive()` invalidations and `LiveInspector` reads) resolve their bindings through the same seam.
  
  **Behavior change:** a send to a registered queue whose producer binding is missing or is not a producer rejects with `Queue 'email' cannot send: ENV.EMAIL_QUEUE is not set: …` (or `… is not a binding of type queue producer …`) instead of the previous wording. A WebSocket upgrade, `Gateways` push, `durableObjectLive()` invalidation or `LiveInspector` read whose gateway's Durable Object binding is missing or is not a namespace fails with `ENV.ROOMS is not set: declare the Durable Object namespace binding 'ROOMS' under durable_objects.bindings …` (or `… is not a binding of type Durable Object namespace …`); an upgrade reports that error through the application's error handler and answers with the redacted 500 body. Upgrades previously answered a plain-text 500 (`Durable Object binding 'ROOMS' is not configured`).
- 088f4d4: Runtime adapters wire platforms into `WebSocketModule` and `LiveModule` through two optional global tokens, so the modules themselves stay the same on every runtime:
  
  - `WS_TRANSPORT` (`@velajs/vela/websocket`) holds a `WebSocketTransport`. Its `createServer(driver)` builds the server gateways inject; without one, the server broadcasts through the module's sync driver as before. A transport whose sockets live in another isolate implements `forwardUpgrade(upgrade)` and names its `forwardingHeaders`: `WebSocketModule` then mounts an upgrade route for each gateway that names a `binding`. The route removes client copies of those headers, resolves the room, runs the gateway's origin, authorization and authenticator checks, reconciles the result with the request's trusted identity (the earlier expiry wins; a conflict answers 403), and passes a `ForwardedWebSocketUpgrade` to the transport. The server and the upgrade routes read one transport, so an application's `@Global()` module that provides and exports `WS_TRANSPORT` overrides the adapter's for both.
  - `LIVE_PLATFORM` (`@velajs/vela/live`) holds a `LivePlatform`. `LiveModule` uses `options.driver?.() ?? platform.liveDriver() ?? localLive()` and `options.log?.() ?? platform.cursorLog?.() ?? new InMemoryCursorLog()`, then hands the driver in effect to `platform.bindDriver?.(driver)`.
  
  `WebSocketModule.forRoot()` and `LiveModule.forRoot()` accept no argument when every option keeps its default.
  
  Add `OpenApiModule` to `@velajs/vela/openapi`. `OpenApiModule.forRoot({ path, info })` serves the application's OpenAPI 3.1 document at `path` (default `/openapi.json`, mounted as given), with no controller to write. The document covers the application root (`ROOT_MODULE`), including contributed routes, under the application's global prefix. It does not read the application's `globalPrefixOptions` or `versioning`: an application that sets either passes the same values to `OpenApiModule.forRoot()` (or returns them from the `forRootAsync` factory); otherwise the document lists excluded routes under the prefix and versioned routes with the default `v` version prefix. It is built on the first request and kept for that application, and it leaves its own route out. The route runs no guards. `forRoot` also accepts `tags`, `servers`, `securitySchemes` and `security`, and `forRootAsync` resolves them through dependency injection.
  
  Add `@ApiExclude()` for a controller or a handler: the routes are still served, but the document and generated clients leave them out. `isApiExcluded(target, handler?)` reads it.
- f267c2f: Global guards run in deterministic phases, whatever order modules register them in: `authenticate` → `tenant` → `authorize` → `feature`. A guard declares its phase with `static readonly phase: GuardPhase` (an instance may carry its own `phase`); a guard without one runs in `feature`, and guards keep registration order within a phase. HTTP, WebSocket and RPC dispatch order the constructed guards, so a guard provided by a factory (`APP_GUARD` with `useFactory`) runs in the phase its instance declares; other transports call `orderGuardsByPhase` from `@velajs/vela/module-kit`. Global guards still run before controller and method guards. `ThrottlerGuard` and `FeatureFlagGuard` are feature guards, so throttling partitions by the identity an `authenticate`-phase guard verifies, and such a guard no longer has to be imported before `ThrottlerModule`.
  
  Each integration installs its guard globally (through the `defineModule` `global:` slot or an `APP_GUARD` provider under the guard's own token, so `overrideGuard(TenantGuard)` and `overrideGuard(CedarGuard)` in `@velajs/testing` reach the installed instance) and takes `guard: 'global' | 'none'`, defaulting to `'global'`: `BetterAuthModule` and `CloudflareAccessModule` authenticate, `TenantModule` admits the tenant, and `AuthzModule` (`PermissionGuard`, `RolesGuard`) and `CedarModule` authorize. `guard` is a structural option with that default, so `forRoot({ ... })` and `forRoot({ ..., guard: 'global' })` are one instance; with `forRootAsync`, pass it beside the factory. The per-phase markers stay: `@Public`/`@OptionalAuth`, `@TenantIgnored`/`@TenantOptional`, `@CedarPublic`. The installed `TenantGuard` and `CedarGuard` cover every application route, including routes in modules that do not import `TenantModule` or `CedarModule` (they admit or authorize through the installing module), whether or not the module is registered with `isGlobal`, and they also run on WebSocket, live-query and RPC entrypoints (see the behavior changes below); a route-level `TenantGuard` or `CedarGuard` in a module that cannot see its module answers 403.
  
  An integration package marks its own controller, which applications cannot annotate, with `SkipGuardPhases(['tenant', 'authorize'])` from `@velajs/vela/module-kit`: the global guards integrations install in those phases do not run for its routes. Only a guard that declares `static readonly skippable = true` is skipped, as `TenantGuard`, `PermissionGuard`, `RolesGuard` and `CedarGuard` do; other global guards run in every phase on these routes, as do authentication, feature and route guards. `skippable` belongs to the guard class, whoever registers it: an application guard that extends an integration guard inherits it, and declares `static override readonly skippable = false` to run on these routes too. The Better Auth handler and the `@velajs/storage` controller skip both phases; the GraphQL endpoint skips `authorize`, because resolvers authorize each field.
  
  To declare route metadata such as Cedar policy on generated CRUD controllers, which applications do not write, use the new `decorators` and `endpointDecorators` resource options of `@velajs/crud`.
  
  `RpcModule` and `rpcAdapter` run the `authorize` policy in the global `authorize` phase, before the other global authorize guards: after global authentication and tenant admission, so a policy can read the trusted identity those guards publish.
  
  **Behavior change:** `CloudflareAccessModule`, `TenantModule` and `AuthzModule` now install their guards globally. Remove `@UseGuards(CloudflareAccessGuard)`, `@UseGuards(TenantGuard)` and `@UseGuards(PermissionGuard, RolesGuard)` where the module now covers the route, or pass `guard: 'none'` and keep a fully route-level pipeline (a global guard runs before every route guard). Mark tenant-free routes with `@TenantIgnored()` or `@TenantOptional()`. `AUTHZ_OPTIONS` is typed as the new `AuthzModuleOptions`. Registrations of `CloudflareAccessModule`, `TenantModule`, `AuthzModule` and `CedarModule` are keyed by `guard` (and Cedar's `undeclared`) instead of by all their options, so a second registration with the same `guard` and other options, such as a feature module's own `AuthzModule` engine with other roles, fails bootstrap: give each additional registration its own `key`, and keep `guard: 'global'` on only one `AuthzModule`, `TenantModule` or `CedarModule` registration.
  
  **Behavior change:** `CedarModule`'s `globalGuard: false` is replaced by `guard: 'none'`, and `CedarGuard` denies (403) application routes without `@RequireResource()` or `@CedarPublic()`, in every module. Set `undeclared: 'allow'` to let them through as before. `undeclared` is structural, like `guard` (default `'deny'`): with `forRootAsync`, pass it beside the factory, which cannot return it.
  
  **Behavior change:** the guards `CloudflareAccessModule`, `TenantModule`, `AuthzModule` and `CedarModule` install run wherever the application's global guards run, not only on controller routes: on WebSocket gateway messages, on the check before each push to a socket (a gateway or live-query push, run with the gateway class), on the reserved `$live` frames that subscribe to and unsubscribe from live queries and send presence heartbeats (run with the framework's `LiveEngine` class, which applications cannot annotate) and on RPC procedures. `SkipGuardPhases` applies only to controller routes. With default options:
  
  - `CedarModule` (`undeclared: 'deny'`): a gateway message without `@RequireResource()` or `@CedarPublic()` answers an `exception` frame (`code: 'internal'`), pushes are not delivered, `$live` frames get no reply, and an undeclared RPC procedure answers a 403 failure frame. The guard @velajs/authz-cedar 1.30.0 installed let undeclared handlers through.
  - `TenantModule`: gateway messages, pushes and `$live` frames fail the same way, because a socket context has no request to select the tenant from. RPC procedures require a tenant and an authenticated identity, as routes do (400 without them).
  - `CloudflareAccessModule`: every gateway message, push and `$live` frame fails, in `mode: 'optional'` too, because the guard verifies HTTP requests only. RPC procedures require an Access identity, as routes do.
  - `AuthzModule`: handlers without `@Roles()` or `@RequirePermission()` pass; those declarations on gateway handlers and RPC procedures are now enforced.
  
  A guard failure on a `$live` frame or a push reaches only the error reporter, which does not log 4xx errors by default; a rejected presence heartbeat leaves the socket out of its room's presence roster. Mark gateway classes and RPC providers or procedures with `@CedarPublic()` or `@RequireResource()`, and with `@TenantIgnored()` or `@TenantOptional()`; a marker on the gateway class, not on a handler, also admits its pushes. Markers cannot reach `$live` frames: for live queries and presence, give `TenantModule` a `resolve` option that returns the tenant of a socket context (from the connection's verified identity, `normalizeWebSocketUpgradeIdentity(client.data)` from `@velajs/vela/websocket`), set Cedar's `undeclared: 'allow'`, or pass `guard: 'none'`. `CloudflareAccessModule` has no socket option: an application with gateways or live queries passes `guard: 'none'`, authenticates HTTP routes with `@UseGuards(CloudflareAccessGuard)` and sockets at upgrade with `CloudflareAccessUpgradeAuthenticator`; global guards run before route guards, so it applies the tenant and authorization guards on those routes too (`guard: 'none'` on their modules).
  
  **Behavior change:** The RPC `authorize` policy runs after global authentication and tenant guards instead of before every global guard. A policy that denied callers because the identity was not yet published now sees the identity an `authenticate`-phase guard publishes.
  
  **Behavior change:** an application's own global guard without a `phase` runs in `feature`, where @velajs/vela 1.30.0 ran every global guard in registration order. A custom global authentication guard, such as an `APP_GUARD` JWT guard, that does not declare `static readonly phase = 'authenticate'` now runs after the tenant and authorize guards the integrations install (`TenantGuard`, `PermissionGuard`, `RolesGuard` and `CedarGuard`) and after the RPC `authorize` policy, so they run without the identity it publishes, and it runs in import order relative to `ThrottlerGuard`. Declare `static readonly phase = 'authenticate'` on such a guard, and `'tenant'` or `'authorize'` on a custom global tenant or authorization guard.
- dfe925c: CORS is configured as in Nest. `app.enableCors(options?)` on `VelaApplication` and the `cors` create option (`VelaFactory.create(AppModule, { cors: true | CorsOptions })`) serve Hono's `cors` middleware ahead of body limits, routing and guards, so preflights are answered before any guard runs and refusals stay readable cross-origin. `enableCors` takes effect on the next request with no rebuild; a later call replaces the options. A credentialed `'*'` origin and a `maxAge` that is not a non-negative integer are rejected. `CorsOptions` is exported from `@velajs/vela`. On Workers, `createCloudflareWorker(AppModule, { cors })` and `createCloudflareApp(AppModule, { env, cors })` take the same option, and `CloudflareApplication.enableCors()` works inside `configure(app, env)`. Every application now carries Hono's `cors` middleware, and one pass-through middleware when CORS is off.
  
  **Behavior change:** `CorsModule` and `CORS_OPTIONS` are removed from `@velajs/vela/security`, and `CorsOptions` moves from `@velajs/vela/security` to `@velajs/vela`. Replace `imports: [CorsModule.forRoot(options)]` with `app.enableCors(options)` or the `cors` create option; the options keep their shape (`origin`, `allowMethods`, `allowHeaders`, `exposeHeaders`, `credentials`, `maxAge`). Options `CorsModule` passed through unchecked now throw when CORS is enabled: `credentials: true` with a `'*'` origin (browsers refuse it) and a `maxAge` that is not a non-negative integer. CORS now runs ahead of the body and query limits and every global middleware instead of among the global middleware, so their refusals carry the CORS headers. Without `allowMethods`, a preflight now allows Nest's defaults (GET, HEAD, PUT, PATCH, POST, DELETE); `CorsModule` sent no `Access-Control-Allow-Methods` then, so browsers refused cross-origin PUT, PATCH and DELETE. `SecurityModule`'s exact-origin `cors` option is unchanged, but it can no longer be combined with framework CORS: while it is on (it is unless `cors: false`), the `cors` create option fails bootstrap and `app.enableCors()` throws, because that middleware would answer every preflight before `SecurityModule`'s method and header checks.
- fd11d20: Push to a gateway's rooms from anywhere with `Gateways`, injectable from `@velajs/vela/websocket` wherever `WebSocketModule` is imported: `gateways.of<ChatEvents>(ChatGateway).to(room).emit('message', data)`. The explicit event map (event name → payload) types each push; `to(room)` and `in(room)` chain rooms. The target comes from the gateway's `@WebSocketGateway` metadata (`path`, `binding`, `roomParam`), and each push is bounded by that gateway's `maxFrameBytes` before anything is resolved or sent. `emit()` without a room and `except()` throw with guidance, and a class without `@WebSocketGateway` is rejected. The handle types are `GatewayServer<Events>` and `GatewayBroadcastOperator<Events>`.
  
  - A push reaches only that gateway's sockets on every runtime, so two gateways may use the same room id (such as an organization id) without one gateway's pushes reaching the other's sockets. `BroadcastCommand` gains an optional `gatewayPath`, which `Gateways` sets on every push and synchronized commands validate; `WsClient` gains an optional `path`, the gateway route the socket connected through (`NodeWsClient` and the Cloudflare client set it). The in-memory and Durable Object room registries deliver a command that names a gateway path only to sockets whose `path` matches, so a socket without one receives no gateway push or broadcast.
  - A gateway's `@WebSocketServer()` is that gateway's own server, scoped the same way: on node, Bun and Deno its broadcasts, including a global `emit()`, carry the gateway path and reach only the sockets connected through that gateway, where they previously reached every gateway's sockets in the named rooms. This holds for `@Inject(WS_SERVER)` in a gateway's constructor and for a constructor inherited from a base class (each gateway gets its own server), and `afterInit(server)` receives the server that injected handle pushes through: pushes through either reach the same sockets, but they are not the same object. Each broadcast is bounded by the gateway's own `maxFrameBytes`. `WebSocketModule` connects each gateway's server while the application starts, before any lifecycle hook runs, from the `WS_SERVER` the gateway's module sees when it sees exactly one, including one provided by an async `useFactory`. When it sees none, or only the servers of several `WebSocketModule` instances it imports, a `WebSocketModule` instance's own server serves the gateway; a module that sees another module's `WS_SERVER` beside those fails bootstrap with an error naming each module that provides one. A test double provided as `WS_SERVER` in the gateway's module, or through `overrideProvider(WS_SERVER)` in a testing module, receives the gateway's pushes as long as `WebSocketModule.forRoot()` stays imported: a `WS_SERVER` without `WebSocketModule` connects nothing. `WS_SERVER` injected outside a gateway still addresses every gateway's sockets. `WsServer` gains an optional `forGateway(gatewayPath, maxFrameBytes)`, which `WsServerImpl` implements (and its constructor takes an optional `gatewayPath`); a transport server without it is shared by every gateway as before. On Cloudflare each Durable Object holds one gateway's room, so behavior there is unchanged.
  - Presence rosters belong to one gateway room: heartbeats in a room of one gateway no longer appear in, or refresh, the `$presence.roster` of another gateway's room with the same id. `LiveQueryContext` gains `path`, the route path of the gateway the connection subscribed through, and a `@LiveQuery` tags function receives it as `(args, context)`. A `coalesceBy` partition is keyed by that path too, next to the query and its canonical args, so a resolver that answers per gateway never shares one run between subscribers of two gateways. `PresenceService.beat(gatewayPath, room, clientId, meta?)`, `PresenceService.roster(gatewayPath, room)` and `presenceTag(gatewayPath, room)` take the gateway path first; `inspectRooms()` still reports each room once, with the members of every gateway that uses its id. A roster's tag, `presenceTag(gatewayPath, room)`, is `$presence:` and the SHA-256 hex digest of the JSON `[gatewayPath, room]`, so every valid room id (up to 512 bytes) fits the 256-byte bound of an invalidation tag on any gateway path; room ids longer than 246 bytes previously failed the roster subscription. A heartbeat or departure whose roster invalidation the live driver fails to dispatch is reported through the application's error reporter instead of becoming an unhandled rejection.
  - A custom `RoomRegistry` passed to `WebSocketModule.forRoot({ registry })` must skip sockets whose `path` differs from `cmd.gatewayPath` in `deliverLocal`, as the built-in registries do; one that ignores the field delivers every gateway push and broadcast to all gateways' sockets in the named rooms. With `redis()`, upgrade every instance together: instances on an earlier release ignore `gatewayPath` and deliver to every gateway's sockets in the room.
  - Without a platform transport that delivers pushes, a push goes through the module's sync driver: in-process hosts (node, Bun, Deno) deliver it to the gateway's sockets in this process, and `redis()` fans it out to the gateway's sockets on every instance.
  - A platform transport delivers pushes elsewhere with the new optional `WebSocketTransport.deliver(delivery)`, which receives one `GatewayDelivery` (`{ gatewayPath, binding?, room, command }`) per gateway room; a gateway without `roomParam` has one room, its path. A push delivered to several gateway rooms settles every delivery first; when some fail it rejects with an `AggregateError` whose message names the failed rooms (`2 of 3 ChatGateway room pushes failed: "b", "c"`; past ten rooms, the first ten and how many more) and whose `errors` hold one error per failed room with the transport's error as its `cause`, while a push delivered to one room rejects with the transport's own error. A transport that delivers pushes but builds no server gives gateways a `@WebSocketServer()` that keeps no sockets and refuses each push with guidance to `Gateways`. A transport that forwards upgrades (`forwardUpgrade`) but implements neither `deliver` nor `createServer` keeps a gateway with a `binding` out of this process's reach under the `local()` sync driver: a push to it, through `Gateways` or through its `@WebSocketServer()`, rejects with guidance instead of resolving without reaching anyone. A cross-instance sync driver such as `redis()` may reach the isolate that holds its sockets, so both push paths then hand it the command.
  - On Cloudflare, a push from the Worker is a `broadcast` RPC to the gateway + room Durable Object, whose namespace is read by the gateway's `binding` from `ENV` when the push needs it. Inside a Durable Object, a push to its own room goes to its sockets, and a push to another room goes to that room's object instead of reaching no one. Pushing to a gateway without a `binding` fails with guidance.
  - The `Gateways` service and the refusing server live in the core WebSocket entry, which a minimal `createCloudflareWorker()` Worker does not load, and upgrades, pushes and live invalidations share one gateway-room resolver.
  
  **Behavior change:** a gateway's `@WebSocketServer()` no longer reaches other gateways' sockets, and it is no longer the `WS_SERVER` instance itself; a gateway that must address every gateway's sockets injects `WS_SERVER` into another provider. `WebSocketModule` connects a gateway's server: in an application or testing module without it, a `WS_SERVER` provided next to the gateway, or overridden with `overrideProvider(WS_SERVER)`, no longer reaches the gateway, whose pushes throw with guidance. Import `WebSocketModule.forRoot()`; a test double then serves the gateway when it is provided as `WS_SERVER` in the gateway's module or overridden in the testing module next to that import. A custom transport's `WsClient` must set `path` to its gateway's route: a socket without one receives no `Gateways` push and no broadcast from a gateway's `@WebSocketServer()`. `LiveQueryContext.path` is required, so code that builds a context, such as a resolver unit test, sets it; `PreparedLiveQuery.tags(context)` takes the subscribing connection's context. `PresenceService` methods and `presenceTag` take the gateway path first, and a presence tag is `$presence:` and a SHA-256 hex digest instead of the room id. `broadcastToRoom(namespace, gatewayPath, room, event, data, options?)` and its `BroadcastNamespace` type are removed from `@velajs/cloudflare`. Inject `Gateways` and call `gateways.of(Gateway).to(room).emit(event, data)`; the gateway's metadata supplies the namespace, path and frame limit.
- 748e4f8: HTTP error edges answer only statuses from 400 to 599. As in Nest, `new HttpException(response, status)` still accepts any status and `getStatus()` returns it, but an exception constructed with another status, such as 200 or 302, is reported and renders as a redacted 500 (`{ error: { code: 'internal', message: 'Internal Server Error' } }`) instead of being sent with that status (with its object body, or an internal error body for a string response). `getErrorStatus()`, and so an exception filter's plain result, uses 500 for it too. Redirect with `@Redirect()` or by returning a `Response`.
  
  A Hono `HTTPException` follows the same range. The raw Hono `onError` edge skips reporting only one with a 4xx status, a deliberate client response. In @velajs/vela 1.30.0 it skipped reporting every `HTTPException` below 500 and sent that exception's own response, so a raw middleware's `new HTTPException(302)` answered 302 with no report recorded.
  
  **Behavior change:** `new HttpException(response, status)` with a status outside 400–599, such as `new HttpException('moved', 302)`, no longer answers with that status: it is reported and answers a redacted 500, and an exception filter's plain result for it is sent with 500. Redirect with `@Redirect()` or by returning a `Response` (for example `Response.redirect(url, 302)`) instead of throwing a 3xx `HttpException`.
  
  **Behavior change:** a Hono `HTTPException` with a status outside 400–599 and no `res`, such as `new HTTPException(302)` thrown from raw Hono middleware, a raw Hono route or a Vela middleware, no longer answers with its own response: it is reported and answers a redacted 500. One built with its own `res`, such as `new HTTPException(302, { res: Response.redirect(url, 302) })`, still sends that response, but the raw Hono edge now reports it on every request. Redirect with `c.redirect()` or a returned `Response` instead of throwing a 3xx `HTTPException`.
- 096e259: Declarations on an ancestor class apply to the classes that extend it, as reflect-metadata resolves them in Nest. In @velajs/vela 1.30.0 every reader looked only at the concrete class. Route decorators (`@Get()`, `@Post()`, …) are still read from the controller class itself, unlike Nest: a method an ancestor routes is not mounted on the subclass. Route an inherited method on the subclass, for example `Get('list')(Sub.prototype, 'list', descriptor)`.
  
  - Class metadata applies to a subclass through every `Reflector` form (`get`, `getClass`, `getAll`, `getAllAndOverride` and `getAllAndMerge`, with an execution context, `context.getClass()` or the `[context.getHandler(), context.getClass()]` list): the controller's own, else the nearest ancestor's, so `@Roles(['admin'])` on an abstract base controller guards every controller that extends it.
  - Method metadata an ancestor declares on a method the controller inherits without overriding, such as one it routes with `Get()(Sub.prototype, 'list', descriptor)`, applies through every `Reflector` form too: the nearest declaration wins, the controller's own, else the nearest ancestor's. A method the controller overrides reads only its own declarations, and metadata one controller declares on a shared method never applies to a sibling.
  - Class-level `@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters` and `@UseMiddleware` on an ancestor run for the subclass on every transport, the root class's first and the subclass's own last. On an inherited method, the method-level enhancers each ancestor declares run before the controller's own, and `@Serialize` and `SkipGuardPhases` read the nearest declaration. The module loader registers the enhancer classes a class inherits, as it does its own.
  - Guards that read route metadata, such as `AuthGuard`, `RolesGuard`, `PermissionGuard`, `TenantGuard`, `CedarGuard`, `FeatureFlagGuard` and `ThrottlerGuard`, enforce inherited requirements, and `authorizationAudit()` and `auditCedarRoutes()` read declarations as the guards do. `CacheModule` checks `@CacheResponse` at bootstrap as `CacheInterceptor` reads it, and `ThrottlerModule` checks `@Throttle()` as `ThrottlerGuard` reads it, inherited declarations included, so an invalid inherited declaration, such as tags without an invalidation store or a throttler the module does not declare, fails bootstrap instead of every request.
  
  **Behavior change:** class metadata and class-level enhancers an ancestor declares, and the metadata, method-level enhancers, `@Serialize` and `SkipGuardPhases` an ancestor declares on a method a controller inherits unchanged, now apply to the classes that extend it. Requirements such as `@Roles()`, `@RequirePermission()` or `@RequireResource()` there are enforced, where the routes previously ran without them. Opening markers apply the same way: an inherited `@Public()`, `@OptionalAuth()`, `@TenantIgnored()`, `@CedarPublic()`, `@SkipThrottle()` or `SkipGuardPhases` now opens or relaxes routes that previously required authentication, tenant admission, Cedar authorization or throttling. Remove a declaration from the ancestor, or override the method in the controller, where a subclass must not inherit it.
- fd11d20: Add `@LiveInvalidates(tags, { room? })` to `@velajs/vela/live`. It runs as an interceptor on a handler: after the handler succeeds it invalidates the tags, static or derived from the result and the execution context (`(result, context) => tags`, where `[]` skips the invalidation), and stamps `Vela-Commit-Cursor` / `Vela-Commit-Epoch` on the handler's HTTP response through `switchToHttp().getResponse()`, or on a `Response` the handler returns. A mutation no longer needs `@Res()` and `stampCommitHeaders` to expose its commit. A handler that throws invalidates nothing. The interceptor resolves `LiveInvalidation` from the module that declares the controller before the handler runs, so a module that cannot reach `LiveModule` fails without committing the write. The tags callback's result type must match the handler's. An invalidation that fails after the handler has committed its write (a tags or room callback that throws, a live driver that cannot reach the room) does not fail the request: it is reported through the application's error reporter (`edge: 'live'`, `source` the handler's `Class.method`, note `invalidation failed after the handler succeeded`), and the request answers with the handler's result without commit headers, so the client drops its optimistic layer and subscribers catch up at the next invalidation of those tags. A failed response would invite a retry that repeats the committed write, which cannot repair the invalidation; keep write handlers idempotent, or accept an idempotency key, for clients that retry a request whose response they never received.
  
  Add `LiveInspector`, provided and exported by `LiveModule`: `inspect(rooms)` returns the subscription and presence rows of the named rooms (there is no global room list), read where their subscriptions live. A runtime adapter reads a room through the new optional `LivePlatform.inspect(room)`; without it, the application's engine answers. On Cloudflare the Worker calls the room Durable Object's `inspectLive` RPC through the gateway binding its live driver delivers to. When several named rooms live in one object, each subscription is reported once and each room's members once. The `LiveInspection` type is unchanged. Studio's `livePanel({ rooms })` reads through it.
  
  On Cloudflare, a gateway without `roomParam` keeps every socket in one room Durable Object, named by its path. Worker invalidations for such a gateway now go to that object whatever room they name, as upgrades and `Gateways` pushes do, instead of an object named by the room (`'default'` when none is named) that holds no sockets; `LiveInspector` reads follow the same rule. `liveInvalidateToRoom(namespace, gatewayPath, room, tags)` applies the same rule: for a gateway path without parameters it reaches the object named by the path. The Worker's live driver now validates the commit stamp a Durable Object returns before it reaches response headers.
- fd11d20: A live query's wire name now lives in its shared definition, so each name is declared once: `defineLiveQuery({ name: 'todos.list', args, result })`. The name must be a non-empty string of at most 256 characters, the longest a `sub` frame carries; `defineLiveQuery` throws otherwise. `LiveQueryDefinition<Name, Args, Result>` carries it as its first type parameter (all three default, so a bare `LiveQueryDefinition` accepts any definition).
  
  The server declares `@LiveQuery(definition, { tags })`, for example `@LiveQuery(todoList, { tags: [crudLiveTag('todos')] })`. The engine already validates every result with the definition's `result` schema after the resolver and its interceptors, so a resolver returns its rows as read instead of calling `.parse` itself.
  
  Clients take the same definitions as a list: `createLiveClient({ url, queries: [todoList] })` and `createNativeClient({ queries: [todoList], ... })` infer the contract, keyed by each definition's name. Two definitions with one name throw `LIVE_SCHEMA_DUPLICATE`. `new LiveClient<Contract>({ queries })` takes an explicit contract and no longer infers one from its options; `LiveQueryDefinitions<Contract>` types its list. `@velajs/react` hooks keep their API and are typed from the same list: `createLiveHooks<InferLiveContract<typeof queries>>()`, where `queries` is the array passed to `createLiveClient`.
  
  Engine errors name the definition instead of the removed decorator form: bootstrap reports "two live query definitions are named 'todos.list'" with both resolver methods, and a subscription to an unknown query receives "no live query named '…' is registered".
  
  **Behavior change:** `@LiveQuery(name, definition, options)` is removed; use `@LiveQuery(definition, options)` with `name` in `defineLiveQuery`. `defineLiveQuery({ args, result })` without a `name` no longer type-checks and throws at runtime. The client's `queries` option takes an array of definitions instead of a name-keyed map: replace `queries: { 'todos.list': todoList }` with `queries: [todoList]`. `InferLiveContract` takes the definition list type (`InferLiveContract<typeof queries>`), so React and React Native apps that typed their hooks from a `{ 'todos.list': todoList }` map export `const queries = [todoList]` instead and pass that array to both the client and `InferLiveContract`. The `LiveQuerySchemas` and `LiveQueryParsers` types are removed; use `LiveQueryDefinitions<Contract>` and `LiveQueryDefinition<Name, Args, Result>`. `LiveQueryDefinition<Args, Result>` became `LiveQueryDefinition<Name, Args, Result>`, so a two-argument annotation such as `LiveQueryDefinition<{ id: string }, Todo[]>` no longer compiles (its first argument must be a string type), and one whose `Args` is itself a string type now means a name. Name the query first: `LiveQueryDefinition<'todos.byId', { id: string }, Todo[]>`, or `LiveQueryDefinition<string, { id: string }, Todo[]>` to accept any name; or annotate with `typeof todoById`. `defineLiveQuery<Args, Result>` likewise became `defineLiveQuery<Name, Args, Result>`, with no defaults, so explicit type arguments name the query first as well (`defineLiveQuery<'todos.byId', { id: string }, Todo[]>({ name: 'todos.byId', args, result })`); or drop them and let the definition infer all three.
- d51dbb3: `ThrottlerModule` takes Nest v5 named throttlers: `ThrottlerModule.forRoot({ throttlers: [{ name, ttl, limit }, ...], storage? })`. The global guard counts every request once per throttler, each in its own bucket (the key carries the throttler name), and answers 429 at the first one exceeded; later throttlers are not counted for that request. A throttler without `name` is `'default'`. Headers follow Nest: `X-RateLimit-Limit`, `-Remaining`, `-Reset` and `Retry-After` for `'default'`, suffixed `-<name>` for the others. The guard publishes its decisions under the `RATE_LIMIT` request-context key from `@velajs/vela/throttler`, one `RateLimitInfo` (`{ limit, remaining?, reset }`) per throttler name. `storage` also takes a function of the application's `ENV`, called once per application. Throttlers are validated when the application boots: at least one, unique names made of letters, digits, `_` or `-` (a Nest-style name such as `'per.minute'` fails), positive integer `ttl` (milliseconds) and `limit`. A store can check them too: `ThrottlerStore` gains an optional `validate(throttlers)`, called with the declared throttlers at bootstrap, so a store that cannot serve one fails the application instead of every request. The tracker is unchanged: the verified identity when one is published, else `getTracker` or the client IP.
  
  `@velajs/cloudflare` adds `rateLimitStore({ binding })`, the `ThrottlerModule` storage over Workers Rate Limiting bindings resolved by name from each application's `ENV`: one binding for every throttler, or `{ binding: { burst: 'BURST_LIMITER', sustained: 'API_LIMITER' } }` per named throttler. Each binding's configured limit and period must equal its throttler's `limit` and `ttl` (10 or 60 seconds). The store declares `fixedLimits`, so a `@Throttle()` override that changes a throttler it serves fails the application at bootstrap instead of being silently ignored by the platform. One binding serves only throttlers that share a `limit` and `ttl`. The store checks the declared throttlers at bootstrap, before any binding is charged: a throttler whose `ttl` is not 10 or 60 seconds, throttlers with different values on one binding (the error names the per-throttler form), a throttler the per-name map leaves out, and a map entry naming no declared throttler each fail the application. Workers Rate Limiting counters are kept per Cloudflare location and are eventually consistent, so its limits are approximate, and `X-RateLimit-Reset` and `Retry-After` report the configured period rather than a measured reset.
  
  **Behavior change:** `ThrottlerModule.forRoot({ limit, ttl })` is replaced by `forRoot({ throttlers: [{ limit, ttl }] })`. `@Throttle({ limit, ttl })` becomes `@Throttle({ default: { limit, ttl } })` (both fields optional, each a positive integer, checked when the decorator is applied), and `@SkipThrottle()` skips only the `'default'` throttler; use `@SkipThrottle({ name: true })` for a named one. As in Nest v5, `limit` and `ttl` override separately: a route's `@Throttle({ default: { limit } })` keeps its controller's `ttl`. A `@Throttle()` on a route or controller naming an undeclared throttler fails bootstrap. `ThrottlerStore.increment(key, ttl)` is now `increment(key, ttl, limit, throttlerName)`, `ThrottlerStorageRecord.enforcedLimit` is replaced by the store's `fixedLimits` flag, and `generateKey(tracker, { className, handlerName })` is now `generateKey(context, tracker, throttlerName)`. `THROTTLE_METADATA` and `SKIP_THROTTLE_METADATA` hold the whole decorator records.
  
  **Behavior change:** `ThrottlerGuard` no longer sets the untyped `rateLimit` Hono variable. Its decisions are under the `RATE_LIMIT` request-context key, a record keyed by throttler name (`Readonly<Record<string, RateLimitInfo>>`): replace `c.get('rateLimit')` with `requestContext.get(RATE_LIMIT)?.default`. The default counter key gains the throttler name, `throttler:<Class>:<handler>:<name>:<tracker>` instead of `throttler:<Class>:<handler>:<tracker>`, so counts in a shared store restart after upgrading.
  
  **Behavior change:** `cloudflareRateLimitStore(binding, { limit, periodSeconds })` and its `CloudflareRateLimitBinding` and `CloudflareRateLimitStoreOptions` types are removed. Use `storage: rateLimitStore({ binding: 'API_LIMITER' })` with a throttler whose `ttl` and `limit` match the binding.
- f267c2f: The `Reflector` accepts Nest's targets as well as an execution context: `reflector.get(key, context.getHandler())`, `reflector.get(key, context.getClass())` and `getAll`/`getAllAndOverride`/`getAllAndMerge(key, [context.getHandler(), context.getClass()])`. A handler function reads the metadata of the method it is: `SetMetadata` records the method it decorates, the HTTP, WebSocket and GraphQL transports record the method each route calls when they register it, and every framework execution context records the method `getHandler()` returns, so a method an outer decorator wrapped keeps its metadata. A custom execution context records its handler with `MetadataRegistry.addHandlerMethod(handler, type, name)` from `@velajs/vela/module-kit`. In the list form, `[context.getHandler(), context.getClass()]` reads the method that class routes through the function, so metadata one controller puts on a method it inherits never applies to a sibling controller sharing the method. Alone, as in `reflector.get(key, context.getHandler())` or `[context.getHandler()]`, a function several controllers route with different metadata for the key cannot say which one it serves, so the read throws and points to the execution-context and list forms. A function one controller routes as several methods with different metadata, such as one wrapper function that replaces them, throws in the list form too; the execution context names the method. Plain arrays and plain objects count as equal metadata when their own properties are equal, including any non-index property an array carries, and any other value is compared by identity. `Reflector.createDecorator({ key?, transform? })` stores `transform(value)`, and readers are typed with the transformed value.
  
  **Behavior change:** `ExecutionContext.getHandler()` returns the handler method, as in Nest, instead of its name. The new `getHandlerName()` returns the name (or a framework host's marker symbol). Custom execution contexts implement both; code that used the handler name, such as a cache or throttling key, calls `getHandlerName()`. GraphQL field contexts report the resolver method. `Reflector.getAll()` returns one value per target, typed `Array<T | undefined>` (handler, then class, for an execution context), instead of a `[handler, class]` tuple type.
- 4a06057: `CacheModule` from `@velajs/vela/cache` is the one cache module, asynchronous end to end and built on `defineModule` (`forRoot` and `forRootAsync`). `namespace` and the trusted `scope` resolver stay mandatory. `store` is optional: without it each application gets its own `MemoryCacheStore` of `max` entries (default 1000). `store` and `invalidation` also take a function of the application's `ENV`, called once per application, so a static registration serves every environment. `@CacheResponse({ ttl, tags, key })` caches GET routes and the injected `CacheService` serves `scope(trustedScope)` reads and post-commit invalidation over the same store. `CacheStore` is one interface whose methods may return values or promises, so memory, tiered and KV stores all fit it.
  
  `@velajs/cloudflare` adds `kvCache({ binding })` and `kvCacheInvalidation({ binding })`: `CacheModule.forRoot({ namespace, scope, store: kvCache({ binding: 'CACHE' }), invalidation: kvCacheInvalidation({ binding: 'CACHE_GENERATIONS' }) })` reads each namespace from the application's `ENV` when an operation needs it, and names `kv_namespaces` when it is missing. `ErrorReportContext.edge` gains `'cache'`. `KVCacheStore` and `KVCacheInvalidationStore` accept a namespace or a function returning one.
  
  **Behavior change:** the synchronous cache is removed: the former `CacheModule` (`ttl`, `max`, `isGlobal` registering its interceptor, `varyBy`, synchronous `store`), its `CacheService` (`get`/`set`/`del`/`clear`), `CacheInterceptor`, `@Cacheable()`, `@CacheKey()`, `@CacheTTL()`, `CACHE_MANAGER` and the `CACHEABLE_METADATA`, `CACHE_KEY_METADATA` and `CACHE_TTL_METADATA` keys. Replace `@Cacheable()` + `@CacheKey(key)` + `@CacheTTL(seconds)` with `@CacheResponse({ key, ttl })`, and manual `CacheService` calls with `cache.scope(scope).get/set/invalidateKey`. Credentialed routes that relied on `varyBy` select a private scope from trusted identity in `scope(context)` instead.
  
  **Behavior change:** the asynchronous response cache takes the single names: `ResponseCacheModule` is `CacheModule`, `ResponseCacheService` is `CacheService`, `ResponseCacheInterceptor` is `CacheInterceptor`, `RESPONSE_CACHE_OPTIONS` is `CACHE_MODULE_OPTIONS`, and the types `ResponseCacheOptions`, `ResponseCacheScope`, `ResponseCacheEntryOptions` and `ScopedResponseCache` are `CacheModuleOptions`, `CacheScope`, `CacheEntryOptions` and `ScopedCache`. `AsyncCacheStore` and `AnyCacheStore` are replaced by `CacheStore`. Stored entries keep their keys, so existing KV caches stay valid. Configuring two `CacheModule`s in one application fails bootstrap, as two response-cache modules did.
  
  **Behavior change:** a store, generation or scope failure the cache absorbs as a miss or a false outcome is now reported to the application's error reporter (edge `'cache'`, the operation as `source`): it is logged by default, or passed to the `ExceptionHandler`'s `report`. `onError` still receives it afterwards. A missing or misnamed KV binding is therefore visible on its first use instead of disabling the cache silently; match it in the handler's `dontReport` to mute it.
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
- 1bfc1c1: `StorageModule` from `@velajs/storage` is the one storage module. Its `driver` may be a function of the application's `ENV`, called on the first storage operation of each application, so one static `StorageModule.forRoot` serves every environment without reading a binding at boot. On Cloudflare Workers, `r2Storage({ binding: 'UPLOADS' })` from the new `@velajs/cloudflare/storage` subpath is its native R2 driver: the bucket is resolved by name from `ENV` and validated, and a missing binding fails the operation naming `r2_buckets`. `@velajs/storage` is an optional peer of `@velajs/cloudflare`, needed only by that subpath.
  
  **Behavior change:** the Cloudflare `StorageModule` is removed, with `StorageService`, `StorageManagerService`, `StorageController`, `R2StorageDriver`, `STORAGE_OPTIONS` and the `StorageModuleOptions`, `DiskConfig` and `PresignedUrlConfig` types from `@velajs/cloudflare`. Register a `StorageModule.forRoot({ name, driver: r2Storage({ binding }) })` from `@velajs/storage` per former disk and inject its `StorageService` (`@InjectStorage(name)` for a named bucket). A disk's `root` becomes the bucket's `prefix`, which is static: the `{date}`, `{year}`, `{month}`, `{day}` and `{uuid}` tokens have no replacement, so build such keys in the application. Its HMAC presign-proxy route (`GET /storage/:disk`) is gone and URLs it issued stop working: serve downloads through `publicBaseUrl`, the authorized `http: { download: 'proxy' }` controller, or provider-signed URLs from the S3 or R2 HTTP/hybrid drivers.
  
  **Behavior change:** the `@velajs/vela/storage` subpath is removed with the second `StorageDriver` contract, `expandPathTemplate` and `joinStoragePath` it held for that module, and `STORAGE_SIGNED_URL_PURPOSE` leaves `@velajs/vela/security`. Use `@velajs/storage`'s driver contract and key helpers (`joinKey`, `normalizePrefix`, `sanitizeKey`); `signUrl` and `verifySignedUrl` stay on `@velajs/vela/security` with an application-chosen `purpose`.
- f267c2f: The new `@Ctx()` parameter decorator injects the Hono context (`VelaContext`); `@Res()` still returns it as the response handle.
  
  **Behavior change:** `@Req()` injects the platform `Request`, as Nest's `@Req()` injects the request object, instead of the Hono context. Replace `@Req() c: Context` with `@Ctx() c: Context`, or with `@Req() request: Request` when the handler only read `c.req.raw`. The Better Auth catch-all handler and generated CRUD handlers are migrated.
- f267c2f: Routes compose like Nest's `setGlobalPrefix(prefix, { exclude })` and URI versioning:
  
  - `VelaFactory.create(AppModule, { globalPrefix: '/api', globalPrefixOptions: { exclude: ['health', { path: 'webhooks/:id', method: 'POST' }] } })` serves matching controller routes without the prefix. Targets use the middleware route grammar and match the controller path plus the route path. A relative middleware target resolves under the prefix, so startup fails when one also matches an excluded route that no absolute or controller target of the same middleware covers or excludes. `RouteManager.setGlobalPrefix(prefix, { exclude })` takes the same options, and `createCloudflareWorker`/`createCloudflareApp` pass them through.
  - `VERSION_NEUTRAL` serves a controller or route without a version segment; combine it with numbers (`@Version([2, VERSION_NEUTRAL])`) to serve both.
  - `versioning: { prefix }` sets the text before the version number (default `'v'`; `false` serves `/1/...`).
  - `app.getRoutePathOptions()` returns this composition; pass it to `createOpenApiDocument(AppModule, app.getRoutePathOptions())` so documents match the served paths. The CLI's OpenAPI and client commands and Studio's OpenAPI view use it, and route contributors receive it as `routePathOptions`.
  
  **Behavior change:** With a global prefix, startup fails for any relative `forRoutes()` target that reaches prefixed routes while its written path also matches a route registered outside the prefix, not only a route `exclude` serves unprefixed. An adapter's absolute route counts too: under `globalPrefix: '/api'`, `forRoutes(':resource')` also matches the `RpcModule` endpoint `POST /rpc`, so startup fails. Previously the build failed only when such a target reached no prefixed route at all. Cover the outside route in the same `forRoutes()` with an absolute target (`{ path: '/rpc', absolute: true }`) or its controller, or leave it out with an absolute `exclude()`. An absolute target or exclude accounts only for the outside routes it matches itself: with both `RpcModule` and an excluded `health` route, `forRoutes(':resource', { path: '/rpc', absolute: true })` still fails startup for `GET /health` until that route is covered or excluded too.
- 1ef55ac: `@Sse()` streams Server-Sent Events, as in Nest: its handler returns an async iterable (such as an `async *` generator) or an iterable of `MessageEvent` (`{ data, id?, type?, retry? }`). Each event is streamed with Hono's `streamSSE` as it is produced, the iterable is closed when the client disconnects, and a failure mid-stream is reported without sending its message. A returned `Response` is still sent as is. `@Sse` no longer loads in a Worker that does not use it.
  
  **Behavior change:** `@Sse()` is no longer a plain GET route that sends its handler's result like any other route: the handler must return an iterable or async iterable of `MessageEvent`, or a `Response` (`SseResult`). Another return type no longer compiles, and a handler that returns anything else, such as a JSON object, fails the request with a reported, redacted 500. Yield `MessageEvent`s, or keep returning the `Response` of Hono's `streamSSE(c, ...)`.
- f267c2f: `TRUSTED_REQUEST_IDENTITY` from `@velajs/vela/module-kit` reads the request's trusted identity through `REQUEST_CONTEXT`: `requestContext.get(TRUSTED_REQUEST_IDENTITY)`. It is a read-only view of `getTrustedRequestIdentity(request)`, and `set()` throws, so `setTrustedRequestIdentity` stays the single identity model. `new RequestContextKey(description, { derive })` creates such derived, read-only keys.
- b227d22: Make `defineModule` the one module engine with a uniform contract. A module declares its structural options, the ones that shape its graph, with a second type argument and a `structural` list: `defineModule<Opts, 'name' | 'http'>({ structural: ['name', 'http'], ... })`. `setup` and `key` receive only those fields, `forRootAsync` takes them at the call site (`Pick<Opts, S>`) and its factory returns the rest (`Omit<Opts, S>`); `S` defaults to `never`, where the factory returns the complete options. A spec's `defaults` gives structural options the values a call site may leave out: `key`, `setup` and the comparison of repeated imports see them (the options token receives the options as given), so `forRoot({})` and `forRoot({ guard: 'global' })` are one configuration when `'global'` is the default, and a default for an option outside `structural` throws. `ConfigModule` (`load: []`), `ErrorsModule` (`catalogs: []`), `LiveModule` (`presence: {}`) and `SeederModule` (`seeders: []`) declare theirs, so a call that spells one out is the same instance. Adds `referenceKey(...values)` to `@velajs/vela/module-kit` for a `key` over stateful values: objects, functions and symbols key by reference (held weakly), other values by value. Every first-party module exposes `forRoot()`: `EventEmitterModule` and `HealthModule` gain `forRoot()` and `forRootAsync()`, and `ScheduleModule` and `ScheduleNodeModule` gain `forRootAsync()`; for the three that take no options (`EventEmitterModule`, `HealthModule` and `ScheduleNodeModule`), `forRoot()` and the bare class import are one instance (key `'default'`), so a library and an application that import different forms still share one executor or emitter. The module loader reports a repeated `(class, key)` whose `global` flag differs, including a global instance imported after a bare import of its class.
  
  **Behavior change:** the default instance key is `stableHash` of the structural options only (over the spec's `defaults`), so a module without structural fields has one instance per class: `ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 10 }] })` and `ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 100 }] })` are one key, and the second configuration fails bootstrap instead of becoming a second instance. Give a second instance its own `key`. This includes per-feature clients: two features that each import `HttpModule.forRoot({ baseURL, headers })` with different settings, which were two instances before, now need `key: 'billing'`, `key: 'catalog'` and so on, as do `I18nModule` and the other modules without structural fields. `CacheModule` is the exception: it allows one instance per application, whatever its `key`. `lazy` and the extras (`isGlobal`, or a spec's own `extras`) no longer change the default key and no longer reach the options token; an explicit `key` still names the instance and, as in 1.30.0, never reaches the options token. `setup` sees only the structural fields for `forRoot` too. A `forRootAsync` factory that returns a structural field no longer compiles (`ModuleFactoryOptions` forbids those fields) and fails bootstrap; in the core modules those are `ConfigModule`'s `load`, `ErrorsModule`'s `catalogs` and `handler`, `LiveModule`'s `presence`, `ScheduleModule`'s `dispatch`, `SeederModule`'s `seeders` and `WebSocketModule`'s `sync`, which `forRootAsync` takes beside the factory. `forRootAsync` also throws for a call-site option that is neither in the spec's `structural` list, an extra nor a registration control, such as `HttpModule.forRootAsync({ baseURL, useFactory })` or `AuthzModule.forRootAsync({ roles, useFactory })`; in 1.30.0 the types allowed it and it was merged under the factory's result as a default. Return it from the factory instead. An explicit `key` must be a non-empty string without surrounding whitespace.
  
  **Behavior change:** a repeated `(class, key)` built from different options (closures, class instances and other values compared as before) now fails bootstrap under every diagnostics policy, including the default `'log'` and `'silent'`, instead of warning and keeping the first configuration: either choice would run the other import's consumers on options they never asked for. Import one shared definition, or give each configuration its own `key`. A repeat also no longer registers a generated module's controllers a second time: identical definitions built by two calls mount their routes once, and a repeat whose `global` flag differs adds nothing. The options are compared before the `global` flag, so a repeat that also asks for `isGlobal: true` still fails; only a repeat with the same options and another `global` flag is reported and ignored. An extra at its default, a structural option at the spec's default and an option passed as `undefined`, at any depth, count as not given: `forRoot({ driver })`, `forRoot({ driver, isGlobal: false })` and `forRoot({ driver, prefix: undefined })` are one configuration and one key, as are `forRoot({ presence: {} })` and `forRoot({ presence: { ttlMs: undefined } })`. `stableHash` leaves out a property set to `undefined` at every depth, so `{ a: undefined }` hashes like `{}`. A bare class import configures nothing: a configured import under its key, such as `HttpModule.forRoot({ key: 'default', baseURL })` next to `imports: [HttpModule]`, fails bootstrap in either order instead of leaving one import on the class's defaults, while `forRoot({ key: 'default' })` with no options is the bare import. `forRoot()` alone is the bare import only on the modules whose key is `'default'` (`EventEmitterModule`, `HealthModule`, `ScheduleNodeModule`); `HttpModule.forRoot()` keys by the hash of its (empty) structural options, not `'default'`, so it is a second instance beside `imports: [HttpModule]`, and a module importing both forms is reported (`'throw'` fails bootstrap). Laziness is compared as the instance gets it, so a call site's `lazy: true` on a module that the spec or its `@Module({ lazy: true })` already makes lazy is the same configuration. Hand-written `DynamicModule` repeats may still add controllers.
  
  **Behavior change:** `ConfigurableModuleBuilder` generates Nest's `register`/`registerAsync` by default; call `setClassMethodName('forRoot')` for the previous names. `defineModule` keeps `forRoot`/`forRootAsync`.
  
  **Behavior change:** removed with no alias: `defineConfigurableModule` and `DefineConfigurableModuleSpec` (use `defineModule`), `defineDynamicModule` (return a `DynamicModule` literal), `moduleKey` (use `stableHash` or `referenceKey`), `moduleToken` (use `new InjectionToken`), `provideGlobal` (use the `global:` slot of `setup`, or `{ provide: APP_GUARD, useClass }`), and the plugin API: `definePlugin`, `composePlugins`, `PluginRegistry`, `PluginRootModule`, `PLUGIN_REGISTRY_TOKEN` and the `Plugin` type (compose modules with `imports`).
  
  **Behavior change:** `@Module` no longer accepts `isGlobal`. A module class is global with `@Global()`, which now applies in either decorator order; one instance is global through `DynamicModule.global` (the `isGlobal` extra). `ModuleMetadata.isGlobal` is renamed `global`. `ConfigModuleOptions` no longer declares `isGlobal`: `ConfigModule.forRoot({ load, isGlobal: true })` still takes it, as the extra it is on every module.
  
  **Behavior change:** the module types take the structural type argument `S`. `defineModule`, `DefineModuleSpec` and `ConfigurableModuleAsyncOptions` take it second, right after `Opts`, so explicit type arguments after it move one place (`defineModule<Opts, never, Extras>` names an extras type, and `ConfigurableModuleAsyncOptions<Opts, never, 'create'>` a factory method); `ModuleSetupContext`, `ConfigurableModuleClassType` and `ConfigurableModuleHost` take it last. `ModuleFactoryOptions<Opts, S>` names the factory result.
  
  **Behavior change:** `ScheduleModule` and `ScheduleNodeModule` share one internal registry module, so importing both keeps a single `ScheduleRegistry`; `ScheduleModule.forRoot({ dispatch })` returns a `ScheduleModule` instance that also registers the registry. `ConfigModule.forRootAsync` takes `load` next to its factory, and `validateSchema` may now come from the factory.
  
  **Behavior change:** removed deprecated members: `ValidationPipe.consumeValidated` (no validation receipt exists; let the handler own generated-route validation), and the `path` and `uiPath` options of `mountOpenApi` (use `specPath`, and `swaggerPath`, `scalarPath` or `redocPath`).
- 2c92243: Add the two bootstrap seams `@velajs/testing` builds `overrideModule()` and `useMocker()` on. `bootstrap(rootModule, options, { moduleOverrides })` from `@velajs/vela/internal` loads each replacement wherever the graph imports the overridden module class or `DynamicModule` (the `ModuleLoader` takes the map as its third argument; `BootstrapInternals` and `ModuleOverrides` describe them), and `Container.supplyMissingDependencies(supply)` registers `supply(token)` in each module whose providers inject a token no visible provider satisfies, once per token; a falsy result registers nothing, so the token stays unresolved.

### Patch Changes

- 3418c55: With this release, a minimal `VelaFactory.create()` Worker (one controller, bundled by Wrangler with `--minify`) measures 130,315 bytes raw and 43,658 bytes gzipped, against 118,954 and 40,012 for 1.30.0, within its unchanged size budget.
- Updated dependencies [fd11d20]
  - @velajs/live-protocol@1.24.0

## 1.30.0

### Minor Changes

- 4d0342b: Split the public surface into tiers, and give every exported name exactly one import path. The root `@velajs/vela` is the application kit: `VelaFactory` and `VelaApplication`, `ENV`, modules and dependency injection (`Module`, `Injectable`, `Inject`, `InjectionToken`, `defineProvider`, `defineModule`, `ConfigurableModuleBuilder`, `ModuleRef`, `Scope`), controllers with their route and parameter decorators, named and signed routes, guards, pipes, interceptors, filters and the `APP_*` tokens, `Reflector`, HTTP exceptions and `ErrorsModule`, `@Serialize`, `ConfigModule`, `Logger`, `REQUEST_CONTEXT`, `EXECUTION_LIFETIME` and the lifecycle interfaces. New subpaths hold the rest:
  
  - `@velajs/vela/module-kit`: the seams for module, integration and runtime-adapter authors, such as `Container`, `MetadataRegistry`, `defineMetadata`, `DiscoveryService`, `createDiscoverableDecorator`, `registerEntrypointKind`, `runInEntrypointScope`, `PipelineRunner`, `RuntimeAdapter`, `invokeScheduledJob`, route contributors, trusted request identity, `getRequestContainer`, `assertFactoryInject`, `stableHash` and `lazyProvider`.
  - `@velajs/vela/cache`, `/throttler`, `/schedule`, `/events`, `/health`, `/logging`, `/http-client` (`HttpModule`), `/openapi` (`@Endpoint`, `createOpenApiDocument`), `/security` (`SecurityModule`, `CorsModule`, `Secret`, the signed-URL primitives and the nonce store) and `/dispatch` (`InternalDispatcher`, `@SignedInvocation`).
  - `@velajs/vela/internal` keeps only bootstrap plumbing for first-party tooling (`bootstrap`, `RouteManager`, `ModuleLoader`, `ComponentManager`, `ConfigStore`, `countRegisteredClasses`, …).
  
  Every subpath that ships decorators or decorated classes installs the Reflect metadata polyfill itself, so an application that imports only a subpath still records constructor parameter types, and the package's `sideEffects` list names each of these entries. The per-module build keeps each entry's bare `import './metadata'`, which it would otherwise drop because `sideEffects` names only built files. The `queue` and `live` subsystems import the modules that declare each symbol instead of the root barrel, and their openness audits check that each symbol is exported by the root, `/module-kit` or a feature subpath as the same binding.
  
  **Behavior change:** the names below are no longer exported from their old entry point; import them from the new one. `ValidationPipe`, `defineDto` and the WebSocket gateway API, which were exported from both the root and a subpath, now come only from that subpath. The signed-URL primitives (`signUrl`, `verifySignedUrl`, their options types and the purpose constants), which were exported from both the root and `@velajs/vela/storage`, now come only from `@velajs/vela/security`. Nothing was removed and no API changed its behavior. `HealthCheckException` (`@velajs/vela/health`) and the `MountOpenApiOptions` and `OpenApiUi` types (`@velajs/vela/openapi`) are newly exported.
  
  | Old import | New import | Names |
  |---|---|---|
  | `@velajs/vela` | `@velajs/vela/module-kit` | `AdapterContext`, `assertFactoryInject`, `bindTrustedRequestContext`, `buildEntrypointExecutionContext`, `buildHttpExecutionContext`, `CheckedProviders`, `clearTrustedRequestIdentity`, `composePlugins`, `Constructor`, `Container`, `contributesEntrypoints`, `ContributesEntrypoints`, `createDiscoverableDecorator`, `CreateDiscoverableDecoratorOptions`, `createExecutionScope`, `createLazyParamDecorator`, `createTrustedRequestIdentityStore`, `cronDialectAmbiguity`, `DEFAULT_BODY_LIMIT_BYTES`, `DEFAULT_QUERY_BYTES_LIMIT`, `DEFAULT_QUERY_DEPTH_LIMIT`, `DEFAULT_QUERY_PARAMETER_LIMIT`, `defineConfigurableModule`, `DefineConfigurableModuleSpec`, `defineDynamicModule`, `defineMetadata`, `definePlugin`, `describeToken`, `DiscoverableDecorator`, `DiscoveredClass`, `DiscoveredMethodMeta`, `DiscoveredRegisteredMethodMeta`, `DiscoveredRegistration`, `DiscoveryFilter`, `DiscoveryService`, `enableAmbientContainer`, `Entrypoint`, `EntrypointExecutionContext`, `EntrypointKind`, `EntrypointRegistry`, `ErrorReporter`, `ExecutionScope`, `ExecutionScopeOptions`, `FactoryInject`, `FilterType`, `finishExecutionScope`, `getCatchTypes`, `getCurrentContainer`, `getCurrentRequestContext`, `getEntrypointKinds`, `getEntrypointModuleId`, `getExecutionLifetime`, `getMetadata`, `getRequestContainer`, `getRouteContributors`, `getScopedComponents`, `getTrustedContextRequest`, `getTrustedRequestIdentity`, `GuardType`, `HttpMethod`, `InferToken`, `InferTokens`, `InterceptorType`, `invokeScheduledJob`, `InvokeScheduledJobOptions`, `lazyProvider`, `LazyProviderSpec`, `METADATA_KEYS`, `MetadataRegistry`, `MiddlewareType`, `MissingInjectionMetadataError`, `MissingInjectionMetadataReason`, `ModuleDescription`, `ModuleEntryList`, `moduleKey`, `moduleToken`, `ModuleVisibilityError`, `MultipleProvidersFoundError`, `ParamType`, `parseCronMetadata`, `parseIntervalMetadata`, `PipelineComponentEntry`, `PipelineRunner`, `PipelineRunOptions`, `PipeType`, `Plugin`, `PLUGIN_REGISTRY_TOKEN`, `PluginRegistry`, `PluginRootModule`, `provideGlobal`, `readJsonBody`, `ReadJsonBodyOptions`, `registerEntrypointKind`, `registerRouteContributor`, `ResolvedComponentMap`, `resolveEntrypoint`, `resolveErrorReporter`, `resolvePipelineComponents`, `resolveScopedComponents`, `resolveScopedComponentsAsync`, `ROOT_MODULE`, `RouteContributor`, `RouteContributorContext`, `RouteContributorOpenApiContext`, `RouteDescription`, `runInEntrypointScope`, `RuntimeAdapter`, `SCHEDULE_INVOCATION_SEED`, `scheduledJobComponents`, `ScheduleInvocationSeed`, `setTrustedRequestIdentity`, `setTrustedRequestTenant`, `shouldFilterCatch`, `sideEffectModule`, `stableHash`, `TrustedRequestIdentity`, `TrustedRequestIdentityStore`, `TrustedRequestPrincipal`, `UndefinedModuleError`, `UnresolvedDependency`, `UnresolvedDependencyError`, `UnresolvedDependencyReason` |
  | `@velajs/vela` | `@velajs/vela/internal` | `bootstrap`, `BootstrapOptions`, `BootstrapResult`, `CONFIG_OPTIONS`, `ConfigStore`, `ContainerOptions`, `Diagnostics`, `ModuleScope`, `ProviderSnapshot`, `ROOT_MODULE_ID` |
  | `@velajs/vela` | `@velajs/vela/cache` | `AnyCacheStore`, `AsyncCacheStore`, `Awaitable`, `CACHE_KEY_METADATA`, `CACHE_MANAGER`, `CACHE_MODULE_OPTIONS`, `CACHE_TTL_METADATA`, `Cacheable`, `CACHEABLE_METADATA`, `CacheEntry`, `CacheEntryReader`, `CacheEntryWriter`, `CacheInterceptor`, `CacheInvalidationResult`, `CacheInvalidationStore`, `CacheKey`, `CacheModule`, `CacheModuleOptions`, `CacheResponse`, `CacheResponseOptions`, `CacheService`, `CacheStore`, `CacheTTL`, `MemoryCacheInvalidationStore`, `MemoryCacheStore`, `RESPONSE_CACHE_OPTIONS`, `ResponseCacheEntryOptions`, `ResponseCacheInterceptor`, `ResponseCacheModule`, `ResponseCacheOptions`, `ResponseCacheScope`, `ResponseCacheService`, `ScopedResponseCache`, `TieredCacheStore` |
  | `@velajs/vela` | `@velajs/vela/dispatch` | `InternalDispatcher`, `INVOCATION_AUDIENCE`, `INVOCATION_DEFAULT_TTL_SECONDS`, `INVOCATION_SIGNING_SECRET`, `InvocationClaim`, `InvocationPathTarget`, `InvocationRouteTarget`, `InvocationTarget`, `InvocationTransport`, `RunInit`, `SignedInvocation`, `SignedInvocationGuard`, `signInvocation`, `verifyInvocation`, `VerifyInvocationOptions` |
  | `@velajs/vela` | `@velajs/vela/events` | `defineEvent`, `defineEventVocabulary`, `EventDefinition`, `EventDispatcher`, `EventEmitOptions`, `EventEmitter`, `EventEmitterModule`, `EventEmitterSubscriber`, `EventHandler`, `EventInput`, `EventListenerDecorator`, `EventPayload`, `EventVocabulary`, `ON_EVENT_METADATA`, `OnEvent`, `OnEventMetadata`, `ScopedEventDispatcher` |
  | `@velajs/vela` | `@velajs/vela/health` | `HealthCheckResult`, `HealthCheckService`, `HealthCheckStatus`, `HealthIndicatorFunction`, `HealthIndicatorResult`, `HealthIndicatorService`, `HealthModule`, `HttpHealthIndicator`, `HttpPingOptions`, `ResponseCheckCallback` |
  | `@velajs/vela` | `@velajs/vela/http-client` | `HTTP_MODULE_OPTIONS`, `HttpClientObserver`, `HttpClientRequest`, `HttpClientRequestObserver`, `HttpClientResponse`, `HttpFetch`, `HttpModule`, `HttpModuleOptions`, `HttpRequestConfig`, `HttpRequestException`, `HttpResponse`, `HttpResponseSizeException`, `HttpService`, `HttpTransport`, `RequestConfig` |
  | `@velajs/vela` | `@velajs/vela/logging` | `APP_LOGGER`, `ApplicationLogger`, `ApplicationLoggerOptions`, `consoleLogSink`, `LogDeliveryContext`, `LogFields`, `loggerForScope`, `LoggingModule`, `LogRecord`, `LogSerializationOptions`, `LogSink`, `LogThresholds`, `LogValue`, `parseLogDirective`, `serializeLogValue`, `StructuredLogger` |
  | `@velajs/vela` | `@velajs/vela/openapi` | `ApiDoc`, `ApiDocMetadata`, `ApiResponse`, `ApiResponseEntry`, `ApiResponseOptions`, `ApiTags`, `createOpenApiDocument`, `CreateOpenApiDocumentOptions`, `defineEndpoint`, `Endpoint`, `EndpointBinaryBody`, `EndpointBodyContract`, `EndpointBodyOptions`, `EndpointDefinition`, `EndpointFormField`, `EndpointFormLimits`, `EndpointHandlerOutput`, `EndpointRequest`, `EndpointResponseFormat`, `EndpointResponseOutput`, `EndpointSchema`, `HttpVerb`, `JsonSchema`, `OpenApiDocument`, `OpenApiInfo`, `OpenApiOperation`, `OpenApiParameter`, `OpenApiPathItem`, `OpenApiRequestBody`, `OpenApiResponse`, `zodToJsonSchema` |
  | `@velajs/vela` | `@velajs/vela/schedule` | `Cron`, `CRON_METADATA`, `CronInvocation`, `CronMatcher`, `CronMetadata`, `CronOptions`, `Interval`, `INTERVAL_METADATA`, `IntervalInvocation`, `IntervalMetadata`, `parseCron`, `RegisteredCronJob`, `RegisteredIntervalJob`, `SCHEDULE_DISPATCH`, `ScheduleDecorator`, `ScheduleDispatchMode`, `ScheduleInvocation`, `ScheduleJobRef`, `ScheduleModule`, `ScheduleRegistry` |
  | `@velajs/vela` | `@velajs/vela/security` | `buildSecurityMiddleware`, `CORS_OPTIONS`, `CorsModule`, `CorsOptions`, `HTTP_SIGNED_URL_PURPOSE`, `MemoryNonceStore`, `NONCE_STORE`, `NonceStore`, `OriginProtectionOptions`, `Secret`, `SECURITY_OPTIONS`, `SecurityCorsOptions`, `SecurityHeadersOptions`, `SecurityModule`, `SecurityModuleOptions`, `SignedUrlOptions`, `signUrl`, `STORAGE_SIGNED_URL_PURPOSE`, `verifySignedUrl`, `VerifySignedUrlOptions` |
  | `@velajs/vela` | `@velajs/vela/throttler` | `RateLimitInfo`, `SKIP_THROTTLE_METADATA`, `SkipThrottle`, `Throttle`, `THROTTLE_METADATA`, `ThrottleConfig`, `THROTTLER_OPTIONS`, `THROTTLER_STORAGE`, `ThrottlerGuard`, `ThrottlerModule`, `ThrottlerModuleOptions`, `ThrottlerStorage`, `ThrottlerStorageRecord`, `ThrottlerStore` |
  | `@velajs/vela` | `@velajs/vela/validation` | `defineDto`, `DtoDefinition`, `DtoOptions`, `DtoSchema`, `isStandardSchema`, `isValidationSchema`, `parseSchema`, `parseSchemaAsync`, `RuntimeParser`, `SchemaInput`, `SchemaOutput`, `SchemaParser`, `SchemaValidationError`, `StandardDtoDefinition`, `standardJsonSchema`, `StandardJSONSchemaV1`, `StandardSchemaV1`, `validateSchema`, `ValidationIssue`, `ValidationPipe`, `ValidationSchema` |
  | `@velajs/vela` | `@velajs/vela/websocket` | `assertWebSocketRoomId`, `BroadcastCommand`, `ConnectedSocket`, `MessageBody`, `OnGatewayConnection`, `OnGatewayDisconnect`, `OnGatewayInit`, `RESERVED_WS_EVENT_PREFIX`, `ReservedWsEvent`, `ReservedWsEventHandler`, `ReservedWsEventMetadata`, `RoomRegistry`, `SubscribeMessage`, `SyncDriver`, `trySendWebSocketFrame`, `WebSocketGateway`, `WebSocketModule`, `WebSocketModuleOptions`, `WebSocketServer`, `WS_SERVER`, `WsArgumentsHost`, `WsClient`, `WsDispatcher`, `WsException`, `WsExecutionContext`, `WsMessage`, `WsResponse`, `WsServer` |
  | `@velajs/vela/internal` | `@velajs/vela` | `APP_FILTER`, `APP_GUARD`, `APP_INTERCEPTOR`, `APP_MIDDLEWARE`, `APP_PIPE`, `ModuleRef`, `VelaApplication`, `VelaSecurityOptions` |
  | `@velajs/vela/internal` | `@velajs/vela/module-kit` | `composePlugins`, `Container`, `definePlugin`, `MetadataRegistry`, `ModuleVisibilityError`, `Plugin`, `PLUGIN_REGISTRY_TOKEN`, `PluginRegistry`, `PluginRootModule` |
  | `@velajs/vela/storage` | `@velajs/vela/security` | `HTTP_SIGNED_URL_PURPOSE`, `SignedUrlOptions`, `signUrl`, `STORAGE_SIGNED_URL_PURPOSE`, `verifySignedUrl`, `VerifySignedUrlOptions` |
  
  **Behavior change:** the root no longer loads the feature modules, so `getEntrypointKinds()` lists the `schedule:cron` and `schedule:interval` kinds only once `@velajs/vela/schedule` is imported, in Node as in bundled Workers. `app.entrypoints` is unaffected.

### Patch Changes

- 4467619: Ship `Reflector` and the signed-URL and signed-dispatch services only with Workers that use them. `Reflector`, `UrlGeneratorService`, `SignedUrlGuard`, `InternalDispatcher`, `SignedInvocationGuard` and the `MemoryNonceStore` default for `NONCE_STORE` now declare themselves when their modules load, and `bootstrap` registers every declared service as before: an application-wide singleton that any module can inject, that one `@Global()` module exporting the token overrides, and that the application's own configuration (the `env` option, a runtime adapter, testing overrides) replaces. A bundle that never references one of them no longer contains it; together they took 4,413 bytes gzipped off the reference Worker.
  
  A service whose module is first imported after the application was created, through a dynamic `import()`, registers the first time the application resolves it, with the same standing: one application-wide singleton, request-scoped when it injects a request-scoped provider, and still overridden by a `@Global()` module exporting its token or by the application's own configuration.
- 7372d90: Publish `@velajs/vela` as one JavaScript module per source file instead of shared chunks, so a bundler drops every feature a Worker never imports. A shared chunk kept each decorated feature class it held, because `X = __decorate([...], X)` is a side effect a bundler must keep once any export of that chunk is used, and `VelaFactory` shared a chunk with the root barrel's features. The reference Worker in `scripts/fixtures/worker-size-entry.ts` (one controller and `VelaFactory.create`) shrinks from 66,783 to 51,206 bytes gzipped. Entry points, exports and type declarations are unchanged. The `sideEffects` list now names only files the build emits: `dist/metadata.js`, which holds the Reflect metadata polyfill, was listed before but its code was inlined into a hashed chunk.
  
  `@Cron`, `@Interval` and `@Processor` declare their entrypoint kinds when their modules load, so a bundle that never imports them no longer lists those kinds in `getEntrypointKinds()`. `app.entrypoints` is unaffected: it only lists kinds that have entrypoints.
- c101033: Keep more unused framework code out of Worker bundles. Exception reporting no longer pulls in `LoggingModule` and the structured logger, the route pipeline no longer imports the `@Endpoint` executor (`@Endpoint` supplies it), unused HTTP method and parameter decorators no longer keep `ValidationPipe` and the schema helpers, module-level `InjectionToken`s are marked pure, and the dynamic-module identity fingerprints ship only with the helpers that record identity inputs. `invokeScheduledJob` no longer imports `InternalDispatcher`: the signed policy that `ScheduleModule.forRoot({ dispatch })` contributes brings signed dispatch with it, so a runtime adapter that fires scheduled jobs, such as `createCloudflareWorker()`, no longer ships the dispatcher, `UrlGeneratorService` and the invocation-signing code to Workers that never configure signed dispatch. With the per-module build and the self-registering framework services, the reference Worker in `scripts/fixtures/worker-size-entry.ts` goes from 66,783 bytes gzipped in 1.29.0 to 40,012, its budget ceiling drops from 66,920 to 49,228 bytes gzipped, and the worker-size gate now fails when that Worker bundles a feature module it never uses.
  
  **Behavior change:** a signed `SCHEDULE_DISPATCH` policy provided as a custom provider, instead of through `ScheduleModule.forRoot({ dispatch })`, is refused when its job fires, with an error reported on the `schedule` edge. Configure signed dispatch with `ScheduleModule.forRoot({ dispatch })`. Everything else behaves as before.

## 1.29.0

### Minor Changes

- 07d1713: Bring config namespaces to the NestJS shape. `ConfigModule.forFeature(namespace)` provides one `registerAs` namespace to the importing module, lazily, and merges it into the application's `ConfigService`. A namespace's `KEY` has one owner however it is loaded: `forFeature()` and `forRoot({ load })` of the same namespace (including a global `forRoot`) share one lazy provider, so feature modules resolve it without a `MultipleProvidersFoundError` and its factory runs once. Another namespace object registered under the same name is reported as a module identity collision. `ConfigService<T>` takes the loaded config shape (for example `ConfigService<ConfigShape<[typeof dbConfig]>>` in a constructor) and checks `get`/`getOrThrow` dot paths and their value types against it; `get(path, default)` returns the value type. Without `T`, reads stay `unknown`. Path expansion stops at a fixed depth, so recursive shapes stay cheap to type-check.
  
  **Behavior change:** `registerAs(namespace, envToken, factory)` becomes `registerAs(namespace, factory)`. The factory receives the application's `ENV` (`VelaEnv`) instead of a caller-supplied token; reading the namespace throws a clear error when no runtime seeded ENV. Remove the token argument and read bindings from the factory's `env` parameter, validating each value.
  
  **Behavior change:** `ConfigType` now means the shape of one namespace, as in NestJS: `ConfigType<typeof dbConfig>`. It replaces `InferConfigType`, which is removed with no alias. The previous tuple mapper `ConfigType<[typeof a, typeof b]>` is renamed `ConfigShape<[typeof a, typeof b]>`.
- db18d3a: Add `scope` to `@Controller` options, so `@Controller({ path, scope: Scope.REQUEST })` declares a request-scoped controller.
  
  **Behavior change:** Class decorators record a scope only when one is passed. `@Controller`, `@WebSocketGateway` and `@Seeder` no longer reset the class to singleton, so `@Injectable({ scope })` takes effect whichever side of them it is written on; a class that declares no scope is still a singleton. Declaring two different scopes on one class, for example `@Controller({ scope: Scope.REQUEST })` with `@Injectable({ scope: Scope.TRANSIENT })`, now throws when the class is decorated instead of letting decorator order pick one.
- 07d1713: Add a framework-owned runtime environment. `ENV` is a global `InjectionToken<VelaEnv>` with no default, `InjectEnv()` injects it (`constructor(@InjectEnv() env: VelaEnv)`), and `VelaEnv` is an empty interface that runtime packages augment through declaration merging. A runtime seeds ENV once per application: `VelaFactory.create(root, { env })` and `bootstrap(root, { env })` accept the environment object (a Node host may pass `process.env` from its own entrypoint), and a `RuntimeAdapter` can register it in `configureContainer`. A non-object `env` is rejected at bootstrap.
  
  **Behavior change:** `CONFIG_ENV` is removed, with no alias. Seed the environment through `ENV` instead (the `env` option, a runtime adapter, or `@velajs/cloudflare`). `UrlGeneratorService`, `SignedUrlGuard`, `InternalDispatcher` and `SignedInvocationGuard` now read a string `URL_SIGNING_SECRET` from ENV when no explicit secret or `URL_SIGNING_SECRET` provider is set. ENV carries bindings and secrets, so a `URL_SIGNING_SECRET` variable or secret in the runtime environment now takes effect automatically, including on Workers, where `CONFIG_ENV` was never provided. Non-string values are ignored. Values in ENV come from outside the program: validate each value your own code reads before assigning a domain type.
  
  **Behavior change:** the root barrel no longer re-exports Hono's `env` and `getRuntimeKey` adapter helpers, which were easy to confuse with `ENV`. Import them from `hono/adapter` directly if you still need them.
- bacaacd: Render a string `HttpException` identically from controller handlers, Vela middleware and
  raw Hono middleware: `{ error: { code, message } }`, with the code taken from the status
  (`not_acceptable` for 406, `bad_request` for an unmapped 4xx). Object responses still ship
  verbatim from controller handlers and Vela middleware, and from raw Hono middleware below 500.
  
  **Behavior change:** a 5xx string `HttpException` no longer sends its message to the client;
  the body carries only the status title, such as
  `{ error: { code: 'internal', message: 'Internal Server Error' } }`. Middleware exceptions
  use the canonical body instead of `{ statusCode, message }`, and an `HttpException` thrown by
  raw Hono middleware keeps its status instead of becoming a redacted 500. Its body is still
  redacted to the status title at 5xx, including an object response, such as
  `{ error: { code: 'service_unavailable', message: 'Service Unavailable' } }` for a 503.
- a814199: Add `readJsonBody(c, { maxBytes? })`, the JSON body reader used by `@Body()` and
  `defineEndpoint` `json` groups, for routes registered directly on Hono.
  
  **Behavior change:** JSON bodies must be sent as `application/json` or a `+json` media type
  such as `application/vnd.api+json` (parameters like `charset` are allowed). Any other body,
  including one with no `Content-Type`, is rejected with 415 `unsupported_media_type` instead of
  being parsed as JSON, so a cross-site `text/plain` or form-encoded POST can no longer reach a
  JSON handler without a CORS preflight. Requests without a body still resolve `@Body()` to
  `undefined`. Send `content-type: application/json` from clients and tests that post JSON.
- 1838474: **Behavior change:** `LiveModule` now fails at bootstrap when the application registers no `WsDispatcher`. Subscriptions only arrive over the `$live` WebSocket event, so without `WebSocketModule.forRoot()` (or `CloudflareWebSocketModule.forRoot()` on Cloudflare) every subscribe was dropped without an error.
- 8a3016c: **Behavior change:** `MetadataRegistry.clear()` is removed, with no alias. It had no effect: the registry holds decoration metadata only, and each application keeps its own state in its container. Delete the calls, typically `beforeEach(() => MetadataRegistry.clear())` in tests; no replacement is needed. Framework-internal suites that must wipe decoration metadata keep `MetadataRegistry.reset()`, available from `@velajs/vela/internal`.
- d803a49: Accept Nest's trailing wildcards in `forRoutes()` and `exclude()` targets. A trailing `cats/{*splat}`, like `cats/*`, matches `/cats` and every path beneath it, as in Nest. A trailing `cats/*path` matches one or more characters beneath `/cats` but not `/cats` itself, so `exclude('users/*id')` still runs the middleware on `/users`. A trailing `(.*)` reads as `{*path}` in `forRoutes()`, as Nest 11 rewrites it: `forRoutes('cats/(.*)')` also covers `/cats`, and a lone `forRoutes('(.*)')` matches every request, including `/` and the global prefix's own root. In `exclude()` it keeps the strict reading, so `exclude('cats/(.*)')` still runs the middleware on `/cats`. `'*'`, `'/*'` and `'{*splat}'` match every request.
  
  **Behavior change:** path targets accept only literal segments, `:name` segments and a trailing wildcard. Other syntax now throws at route build, naming its cause, instead of matching whatever one of Hono's routers makes of it: `{regex}` constraints such as `:id{[0-9]+}` or `:action{login|register}` (Hono's TrieRouter anchors only the first and last alternative of a top-level `|`, so the latter also matched `/auth/login-as/42`, and constraints that span segments backtracked), optional `?` segments such as `:id?`, a wildcard before the last segment such as `files/*/raw`, `*/*` or `files/*path/:id`, a `*` or `:` inside a segment such as `us*` or `abc:name`, a parameter name that is not an identifier such as `:name.pdf`, `:from-to` or `:x@1` (Hono's PatternRouter reads `:name.pdf` as `:name` followed by `.pdf`), other parentheses or braces such as `:id(\d+)` or `users{/:id}`, and empty segments such as `a//b`. Use `:name`, list each path, or target the controller.
- b235935: Fix consumer middleware that silently skipped the routes it was bound to. `forRoutes(Controller)` now asks Hono which handler serves each request and runs exactly when it is one of the controller's own handlers, whatever the route's syntax, HTTP method, global prefix or URI version. It also covers an empty-path `@Controller()`, and HEAD requests served by a GET handler. String and `{ path, method }` targets use a small grammar that Vela matches itself, segment by segment, in time linear in the request path: literal segments, `:name` segments with an identifier name that match one segment (decoded line terminators such as `%0A` included) and a trailing wildcard. Hono's routers do not all read these forms the same way: the RegExpRouter's trailing `*` stops at a decoded line terminator, the LinearRouter (used by `hono/quick`) serves `:name` on an empty segment, and the PatternRouter reads `:name.pdf` as `:name` followed by `.pdf`. `forRoutes()` targets take the broader reading and fail closed, so `:name` also matches an empty segment; `exclude()` targets take the strict one, so `:name` matches only a non-empty segment. A trailing wildcard matches decoded line terminators in both. Targets add no routes to the Hono app, so they never change which of Hono's routers the app uses, never conflict with a route such as the `RpcModule` endpoint, and leave the app mountable by a parent on any router. A `forRoutes()` target also covers the paths beneath it. When a parent app mounts the Vela app with `parent.route(base, app)`, path targets match the request path beneath that base, including trailing-slash and parameter bases such as `/m/` or `/:tenant{[a-z0-9-]+}`. Add `RouteInfo.absolute`: `{ path, method?, absolute: true }` matches the path as written, for routes served outside the global prefix such as `mountOpenApi()` documents, the `RpcModule` endpoint, Cloudflare WebSocket upgrades and routes added to the Hono app directly.
  
  **Behavior change:** String and `{ path, method }` targets in `forRoutes()` and `exclude()` now resolve under the global prefix, so write them without it or pass `absolute: true`. A target that still starts with the global prefix throws at route build instead of silently matching nothing. `exclude()` matches its patterns exactly and no longer skips the paths nested beneath them; a trailing `/` is significant. `forRoutes(Controller)` matches only requests Hono dispatches to that controller's own handlers, not every path under its prefix, so a path that another controller's route serves first no longer runs it, and it throws at startup when the controller declares no routes. A request whose method token is `ALL` now matches only targets without a method, as Hono routes it, instead of every method-scoped `forRoutes()` and `exclude()` target. `forRoutes('*')` is unchanged.
  
  **Behavior change:** under a parent app's mount base that does not spell the start of the request path, because Hono decoded a percent-encoded parameter value (`/a%3Ab`) or the request stops at `/m` under a `/m/` base, the middleware now runs and its `exclude()` path targets are ignored for that request. The same applies on every request under a base parameter whose `{regex}` constraint can match a `/`, such as `/:org{.+}` or `/:org{(?:[a-z]+/)?[a-z]+}`, where Hono can give the middleware and the route different values.
  
  **Behavior change:** a `forRoutes()` `:name` segment, including one from a global prefix such as `/:tenant`, now also matches an empty segment, so a parent app on Hono's LinearRouter or `hono/quick` that serves `/app//settings` with `/app/:org/settings` runs the middleware. `exclude()` still needs a non-empty segment.
  
  **Behavior change:** a controller route that a parent app serves without the Vela app's `'*'` middleware, as Hono's TrieRouter does under a mount base whose parameter must span a `/` (`/:org{[a-z]+/[a-z]+}`), now answers 500 with `Vela middleware chain did not run — unsupported mount`, reported like any other server error, instead of running without body limits, global middleware or consumer middleware.
- 08a81c8: Check relative `forRoutes()` and `exclude()` path targets against the routes registered at startup, so a target for a route served outside the global prefix no longer matches nothing silently. The check samples concrete paths shaped like each target and route, reading a `{regex}`-constrained route parameter as one segment, so `forRoutes('users/:id')` reaches `users/:id{[0-9a-f-]{36}}` whatever the constraint; it only reports, and never decides whether a request runs the middleware.
  
  **Behavior change:** with a global prefix, a relative target that reaches no route under the prefix but matches a route served outside it, such as `forRoutes('rpc')` for the `RpcModule` endpoint or a route contributor's path, now throws at route build and names the `{ path, absolute: true }` form to use instead.
  
  **Behavior change:** a relative `forRoutes()` target that matches no route registered at startup is reported through the container's diagnostics policy (`'log'` warns, `'throw'` fails bootstrap). Routes added to the Hono app after startup, such as `mountOpenApi()` documents, WebSocket upgrade paths and `app.getHonoApp()` routes, need `{ path, absolute: true }` with the path they are served on. The report suggests the resolved path with the global prefix kept, such as `{ path: '/api/users/:id', absolute: true }`, never one that drops it.
- 5b5b81d: **Behavior change:** the container plans each class provider's constructor once, at registration, and throws the new `MissingInjectionMetadataError` before anything constructs it when a parameter of a class with a class decorator or `@Inject`/`@Optional` entries has no usable token. That covers a constructor that declares more parameters than its `design:paramtypes` and `@Inject` indexes describe (a build without `emitDecoratorMetadata`), and a parameter whose paramtype is `Object` or `undefined` (an interface, a type-only import, or a circular import) without `@Inject(token)`. Previously the first case constructed the class with `undefined` injected fields, and the second failed only when the class was first resolved. `@Optional()` parameters still resolve to `undefined`, and `forwardRef` tokens are still evaluated at resolution. The error exposes `className`, `parameterIndex` and `reason`. For a missing `design:paramtypes` entry, the message also explains that esbuild emits no decorator metadata, so neither does a Worker that `wrangler deploy --config` bundles itself, and that the build should go through Vite (Oxc with `emitDecoratorMetadata`) or another transform that emits it.
  
  A subclass without its own constructor now inherits its parent's constructor metadata (`design:paramtypes` and `@Inject`/`@Optional` entries) instead of being constructed with no arguments. An unregistered guard, pipe, interceptor, filter or middleware class that inherits constructor dependencies this way now fails with the existing "Cannot instantiate" error instead of being constructed with `new` and no arguments.
  
  A class with no class decorator, such as a third-party client used with `useClass` or an undecorated test fake passed to `overrideProvider().useClass()`, is still constructed with no arguments. **Behavior change:** when it declares constructor parameters, which stay `undefined`, that is reported through the container's diagnostics policy with a message that names the missing class decorator; decorate it with `@Injectable()` or provide it with `useFactory`.
  
  **Behavior change:** registering a provider class that carries no class decorator, and exporting a token that is neither a local provider nor exported by an imported module, are now reported through the container's diagnostics policy: `'log'` warns (with a `[vela]` prefix), `'throw'` fails bootstrap and `'silent'` stays quiet. Both previously always called `console.warn`. `@Module` classes resolved for `configure()`, `@Catch` filters and classes with gateway or discoverable class decorators no longer trigger the missing-decorator warning.
  
  `Reflector`, `SerializerInterceptor` and `ValidationPipe` are now `@Injectable()`, so `defineProvider(APP_PIPE, { useClass: ValidationPipe })` keeps working: its optional schema parameter is `@Optional()`. An unregistered guard, pipe, interceptor, filter or middleware class whose constructor parameters are all tokenless `@Optional()` slots (an erased type with no `@Inject`, like `ValidationPipe`'s schema) is constructed with `new` and no arguments, so `@UsePipes(ValidationPipe)`, `@Body(ValidationPipe)`, `app.useGlobalPipes(ValidationPipe)` and `ValidationPipe` subclasses keep working. An unregistered class whose `@Optional()` parameters name a token (`@Optional() @Inject(TOKEN)` or a class type) is constructed through the container from the requesting module on the request path, so a registered and visible token is injected instead of skipped, and a guard that falls back when its policy is missing cannot fail open; synchronous resolution (such as `resolveScopedComponents`) throws the "Cannot instantiate" error for it. Previously any `@Optional()` parameter made such a class fail with that error.
- 7daf4fc: **Behavior change:** importing the same `(class, key)` module instance twice with different inputs is now reported through the container's diagnostics policy (`'log'` warns, `'throw'` fails bootstrap) instead of silently dropping the repeat's providers. `defineModule`, `sideEffectModule` and `defineConfigurableModule` record the inputs each definition was built from. The loader compares plain values structurally, including their symbol-keyed properties, and functions, symbols and class instances such as tokens by reference, using ids owned by that loader: source text cannot see what a closure captured, so a parameterized helper called with different arguments (`database('PRIMARY_URL')` and `database('ANALYTICS_URL')`) is reported instead of silently keeping the first configuration. A helper that rebuilds one configuration on every call is reported too; the diagnostic suggests importing one shared definition (for example, export a const of the `DynamicModule`) or giving each configuration its own `key`. The first definition still wins, and identical repeats still deduplicate without a diagnostic.
- 35e8e0d: **Behavior change:** `ModuleRef` is now scoped to the module that injects it. The container builds one per module and owner: singletons receive one owned by the application root, and request-scoped consumers receive one bound to their own request, which closes with it. `ModuleRef` is no longer registered in the root bucket, so `container.has(ModuleRef)` is `false`, and its constructor takes `(container, moduleId)`. `app.get(ModuleRef)` still returns an application-wide reference.
  
  - `get(token, { strict })` resolves with the host module's visibility (its own providers, its imports' exports and global tokens) instead of looking the token up across the application. Pass `{ strict: false }` for the application-wide lookup. `get` now throws for request-scoped and transient providers.
  - `resolve(token, context?, { strict })` now returns a `Promise`. `context` is an `ExecutionContext`, the Hono `Context` of a Vela-managed request, or an execution-scope `Container`, and request-scoped providers resolve in that scope. Without a context it resolves where the reference is owned, so a singleton's reference throws for request-scoped providers instead of caching them on the root. It never creates a request scope.
  - `create(Type)` now returns a `Promise` and injects the class's dependencies with the host module's visibility. It no longer bypasses module visibility.
  
  `Container.createDetached()` is removed. Use `moduleRef.create(Type)` or the new `Container.construct(Type, moduleId)`. Adds the `ModuleRefContext` and `ModuleRefLookupOptions` types.
- 4420501: Providers and enhancers are authored as in Nest:
  
  - `@Module({ providers })` accepts `{ provide, useValue | useClass | useExisting | useFactory }` literals, including `APP_*` tokens. Each literal in an array written in `@Module` is checked against its token, so a value, class, alias or factory result of the wrong type does not compile. A literal factory takes no parameters; a factory with dependencies keeps using `defineProvider`, which infers them from `inject`. `@Module` also accepts a `ModuleOptions` object and entries typed with the whole `Provider` or `ProviderLiteral` union, such as a `Provider[]` parameter or `dynamic.providers ?? []`, alone or spread into an array next to other entries (`[...(dynamic.providers ?? []), AuditService]`); their literals are validated when the module loads, while a literal that names its token, in an array literal or in a list declared without a type annotation, is checked against it, also next to a single spread; a literal written between two spreads (`[...shared, literal, ...extra]`) is checked only when the module loads. `DynamicModule.providers` and `defineModule` `setup` contributions accept the loosely typed `ProviderLiteral` union, and the module loader checks each literal when the module loads: an entry that is not a provider fails with an error naming the list entry and its token. Adds the `Provider`, `ProviderLiteral`, `TypedProviderLiteral`, `CheckedProviders`, `FactoryInject` and `ModuleDecoratorOptions` types.
  - A factory without parameters may omit `inject` in `defineProvider`, `lazyProvider`, literals and `forRootAsync` options. Their options intersect `FactoryInject<Inject>` with one `useFactory` type, so a factory's literal results keep their literal types; a module that wraps `forRootAsync` forwards its options object whole (`{ ...options, useFactory }`) and first calls the newly exported `assertFactoryInject(name, options.useFactory, options.inject)`, because its wrapper hides the caller's factory arity.
  - Every application provides `Reflector` globally, so guards and interceptors inject it instead of calling `new Reflector()`. A framework-global token (`Reflector`, `ENV`, `NONCE_STORE`, ...) resolves to the application's registration from every module that neither provides it, imports a module that exports it, nor sees a `@Global()` module that exports it; a module that lists one in its providers uses that local provider.
  - Any Vela class decorator implies `@Injectable()`: discoverable class decorators such as `@Processor` and `@LiveResolver`, and `@Catch`, mark the class injectable without changing a declared scope.
  - Guard, pipe, interceptor and filter classes referenced by `@UseGuards`, `@UsePipes`, `@UseInterceptors`, `@UseFilters` or parameter decorators on a module's class, class providers or controllers (gateways, processors, live resolvers and other entrypoint classes included) need no `providers` entry.
  - `exports: [ImportedModule]` re-exports everything the imported module exports.
  - Module classes are constructed through DI and receive lifecycle hooks.
  
  **Behavior change:**
  
  - Referenced enhancer classes are registered in the declaring module unless one is already visible there, and resolve through the container from that module. A singleton enhancer is now built once, at bootstrap (or with its lazy module), and receives lifecycle hooks, instead of being built with `new` on every request; a request-scoped one, declared or bubbled, is built per request. An enhancer whose dependencies the declaring module cannot see now fails bootstrap with `UnresolvedDependencyError` instead of failing each request, and one registered but not exported by another module gets its own instance instead of a `ModuleVisibilityError`. A referenced class with no class decorator of its own is registered with the dependencies it inherits from a decorated parent class; one with no constructor metadata at all is still built with `new`, once per scope. Classes passed to `app.useGlobalGuards()` and the other `useGlobal*` methods are not scanned.
  - The module class is registered in its own module and constructed at bootstrap (or with its lazy group), and, as in Nest, receives `onModuleInit`, `onApplicationBootstrap` and the shutdown hooks last within its module: after the module's providers, controllers and registered enhancers, and before the providers of the modules that import it. Lifecycle hooks now run module by module, so a module's controllers receive theirs before the providers of the modules that import it instead of after every provider, and each keyed instance of one module class (`forFeature('a')`, `forFeature('b')`) runs its own providers, controllers, enhancers and module class in turn. It now appears among its module's providers in `getModuleDescriptions()` and to `DiscoveryService`, and `app.get(ModuleClass)` returns it. A module class whose constructor dependencies are not visible now fails bootstrap.
  - `exports: [ImportedModule]` no longer reports an unknown export: it expands to the imported module's exports, and a dynamic module is re-exported by its class. Re-exporting a module whose exports a `forwardRef` import cycle leaves unknown throws; export its tokens directly.
  - A class that declares no scope takes the nearest scope a parent class declares with `@Injectable({ scope })`, whether it is a provider, a `useClass` target or an enhancer registered for a module. A subclass of a request-scoped guard, decorated or not, is built per request instead of becoming a singleton shared across requests; declare `@Injectable({ scope: Scope.DEFAULT })` on the subclass to keep one instance.
  - Explicit component lists resolved for a module, such as the operation-level guards `resolvePipelineComponents()` resolves for a GraphQL resolver, use a registration only when that module can see it; a class another module keeps private is built as an unregistered class instead of failing with `ModuleVisibilityError`. A class passed to `app.useGlobalGuards()` and the other `useGlobal*` methods resolves from the first module that registers it and is not a lazy module still pending, so a global component no longer materializes a lazy module another module can serve; when every module that registers it is pending, a lazy module that lists the class in its providers serves it, materialized with its group, and one that holds only the copy registered for an enhancer its classes reference never does.
  - Modules look tokens up in Nest's order: their own providers, then what their imports export (following re-exports), then what the one `@Global()` module that exports the token provides, then the application's registration of a framework-global token, whether the application configured it or the framework registers it by default, or an `InjectionToken` default. A token that a module's imports export now resolves to that export, instead of failing with `MultipleProvidersFoundError` because a `@Global()` module exports it too or another module registers a copy, and, for an `InjectionToken` with a default factory, instead of resolving to the default. An `InjectionToken` default factory applies only when no module registers the token: a module that cannot see another module's registration of it fails with `ModuleVisibilityError`. A `@Global()` module that exports a framework-global token such as `NONCE_STORE` or `Reflector` overrides the application's registration in every module that neither provides the token nor imports an exporter of it, and a copy another module registers without exporting it is no longer a candidate. `resolveAll(token, moduleId)` returns the providers of the step that `resolve(token, moduleId)` takes its provider from, following re-exports, instead of combining the module's own provider, every registration of a global token and its direct imports' exports. Two `@Global()` modules that export one token still fail with `MultipleProvidersFoundError`, and so does a module whose imports export the token from two modules, including a `@Global()` module that it also imports explicitly.
  - An application-wide lookup, which has no requesting module (`app.get(token)`, `ModuleRef.get(token, { strict: false })` and the dependencies of the providers the application registers itself, such as `SignedInvocationGuard`, `SignedUrlGuard`, `UrlGeneratorService` and `InternalDispatcher`), ranks the application's registrations by who made them. What the application configures itself still answers first: the `env` option, a runtime adapter's `configureContainer`, `app.useGlobalExceptionHandler()`, a `@velajs/testing` override, or any other root registration made after bootstrap registered its defaults. Then the one `@Global()` module that exports the token answers, then the framework default that bootstrap registers, such as the `MemoryNonceStore` behind `NONCE_STORE` or `Reflector`, then the first module that registers the token. A `@Global()` module that provides a durable `NONCE_STORE` therefore now protects signed invocations against replay, instead of losing to the framework's `MemoryNonceStore`, while a handler passed to `app.useGlobalExceptionHandler()` still reports instead of the one a global `ErrorsModule.forRoot({ handler, isGlobal: true })` exports. Two `@Global()` modules that export a token the application did not configure itself now fail with `MultipleProvidersFoundError` there too, instead of resolving to the framework default or to the first of them. The new `Container.markRootDefaults()`, which `bootstrap()` calls before it registers the `env` option and runs the adapters' `configureContainer`, ranks the root registrations made so far as framework defaults.
  - A factory that declares parameters but has no `inject` now throws when it is defined, naming its token, instead of running with `undefined` arguments.
  - `DynamicModule.providers` and `ModuleContributions.providers` are typed `Provider[]`, and `ModuleOptions.providers` and `ModuleMetadata.providers` are `readonly Provider[]`: their entries may be literals, which `Container.register()` does not accept; register a `DynamicModule` through a module import instead. `AsyncModuleOptions` and `LazyProviderSpec` are now type aliases instead of interfaces, so an interface can no longer extend them: intersect instead (`AsyncModuleOptions<T, Inject> & { name: string }`).
  - `CacheInterceptor`, `ResponseCacheInterceptor` and `ThrottlerGuard` take the injected `Reflector` as their last constructor parameter; a subclass that declares its own constructor passes it to `super()`.
  - `isInjectable()` returns `true` for classes decorated with a discoverable class decorator or `@Catch`.
- 6d4f0c0: **Behavior change:** `@Optional()` now decides by module visibility. It still injects `undefined` when no module registers the token. When another module registers the token without exporting it to the consumer, the mistake is reported through the container's `diagnostics` policy: `throw` fails construction with `ModuleVisibilityError`, `log` warns once per consuming module and injects `undefined`, and `silent` injects `undefined`. Previously such a dependency threw `ModuleVisibilityError` in every mode. An `@Optional()` `InjectionToken` with a default `factory` now receives the factory's value instead of `undefined`.
- e3bda2a: Module-level `@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters` and `@UseMiddleware` now run once per request when the same module classes are bootstrapped more than once in an isolate (per-environment rebuilds, Durable Object instances, tests). Previously every bootstrap added another copy to the module's controllers, so later applications wrapped responses twice and ran guards such as throttling twice.
  
  **Behavior change:** module-level components are resolved per application from the module instance that declares the controller instead of being copied onto the controller's metadata. `MetadataRegistry.propagateControllerComponents()` is removed, and `MetadataRegistry.getController()` returns only a class's own decorations. The static `ComponentManager.getScopedComponents(type, controller, handlerName)` from `@velajs/vela/internal` is removed; use the new `getScopedComponents(type, class, method, container, moduleId)` from `@velajs/vela` instead, which reads the declared entries, module-level ones included, without constructing them; `resolveScopedComponents()` and `resolveScopedComponentsAsync()` include them for the owning `moduleId` (or the class's only owner when it is omitted). The `@velajs/authz` authorization audit and `@velajs/mail` inbound dispatch recognize module-level components the same way.
- bd7e3c9: Add Nest-style queue registration to `@velajs/vela/queue`. `QueueModule.forRoot({ driver, dispatch })` configures the application's driver once and is global; `QueueModule.registerQueue({ name, binding?, consumer? })` registers a queue in the module that uses it and provides its `QueueClient`, which `@InjectQueue(name)` injects (the same as `@Inject(queueToken(name))`). `registerQueue` accepts several queues in one call, and declares no class for them, so calling it again, for example each time an application is rebuilt, does not grow the isolate's decorator metadata. Registering one queue in several modules is fine: registrations are merged by name, their `consumer` pins accumulate, and two different bindings for the same name fail bootstrap. `QueueRegistry` (exported by the module) lists the merged registrations, and each registered queue is published as a portable `queue:registration` entrypoint (`{ name, binding?, consumers }`) for deployment checks.
  
  Add `QueueClient.addBulk(jobs)`, which validates every typed job before any is sent, then hands the whole batch to the new optional `QueueDriver.enqueueBatch(requests)`, or enqueues one job at a time when the driver has none. It resolves only when every job was accepted; otherwise it rejects with a `QueueBatchError` whose `accepted` and `rejected` list the job ids. Each entry (`QueueBulkEntry`) has the `{ job, data, options }` shape of an `add(job, data, options)` call, not BullMQ's `{ name, data, opts }`; an entry with any other key, such as `opts`, does not compile. Each entry is typed on its own, so named entries with different payloads and typed and named entries can share one call.
  
  Each failure of a native batch delivered through `QueueModule`'s consumer is reported once on the `queue` edge: processor failures where the processor ran, and a message that is not a job, an unregistered or mis-pinned queue, a job no processor handles or a rejected signed re-entry when the batch settles.
  
  A driver factory (`driver: (context) => QueueDriver`) now receives a `QueueDriverContext`: the application's `ENV`, when a runtime seeded one, and its `QueueRegistry`. A factory still builds a fresh driver for each application.
  
  **Behavior change:** `QueueModuleOptions.queues` is removed, from `forRoot` and `forRootAsync` alike. Replace `QueueModule.forRoot({ queues: ['email'], driver })` with `QueueModule.forRoot({ driver })` plus `QueueModule.registerQueue({ name: 'email' })` in the module that produces or processes the queue. `forRoot()` takes no required options, is global, and is imported once per application: two different `forRoot` configurations now fail bootstrap. The driver and a signed `dispatch` policy compare by reference, so a different driver instance or another signed policy object conflicts, even one that differs only in its target, method or TTL, or one a helper builds from the same source with another captured target; importing the same objects again deduplicates. `forRootAsync` is keyed by its options object, with or without an explicit `key`: importing the same object again deduplicates, and a different one, including one that shares its `key`, or a `forRoot` next to it, fails bootstrap. `dispatch` may now come from a `forRootAsync` factory.
  
  **Behavior change:** `QueueDispatchBinding.dispatch(job, options?)`, the entry point for platform deliveries, rejects a job whose queue is not registered in the application and, unless `options.unhandled` is `'ignore'`, a job no processor handles (options that omit `unhandled`, such as `{}`, keep that default), so the platform retries it instead of acknowledging it, and resolves with a `QueueDispatchResult` (`handled` is 1 for a signed re-entry). The binding's constructor takes the application's `QueueRegistry` instead of a list of queue names.
  
  **Behavior change:** `dispatchQueueJob(container, entrypoints, job, options?)` honors the application's `QueueModule` dispatch policy. When the application imports `QueueModule.forRoot()`, it delivers through `QueueDispatchBinding` like a native delivery: the job's queue must be registered, and signed dispatch re-enters the signed route, so a custom transport can no longer bypass the route's global guards. Without a `QueueModule` it still calls the processors directly. `dispatchQueueJob` is for tests and for transports other than Cloudflare Queues, which `cloudflareQueues()` delivers itself; a raw `@QueueConsumer` must not carry jobs of registered queues, so do not bridge one to processors with it.
  
  **Behavior change:** `dispatchQueueJob` rejects a job no processor handles, such as a misspelled or removed job name, instead of resolving with `handled: 0`: `options.unhandled` now defaults to `'error'`, as for a native delivery, so a custom transport that acknowledges a message when delivery resolves never loses one. A transport acknowledges a message only when `dispatchQueueJob` resolves and lets it be retried when it rejects. Pass `{ unhandled: 'ignore' }` to keep resolving with `handled: 0`.
  
  **Behavior change:** `QueueDriverEntrypoint` no longer has a `queue` field; a driver's platform routes carry only `kind` and `meta`.
  
  **Behavior change:** a processor failure is reported once, where the processor ran, on every delivery path. A detached inline delivery (`inline()` in `immediate` mode) no longer reports it a second time with `note: 'inline driver'`; that note is kept for failures no processor reported. A processor that throws a value that is not an object (`throw 'boom'`) is reported with that value and then rethrown as an `Error` whose `cause` is the value, so a transport that settles several deliveries recognizes it as already reported.
- 2b74880: Remove `ZodValidationPipe`. It called `schema.parse()` directly, so invalid input
  escaped as a raw validator error and was answered with a 500 instead of a 400.
  
  **Behavior change:** `ZodValidationPipe` is no longer exported. Replace
  `new ZodValidationPipe(schema)` with `new ValidationPipe(schema)`, which accepts a Zod or
  other Standard Schema, a `parse()` parser, or a `defineDto` descriptor. Invalid input now
  receives a 400 whose body carries `message: 'Validation failed'` and the normalized
  `errors`; an exception thrown by a validator itself is still a server error.
- 5ba8635: **Behavior change:** `REQUEST_CONTEXT.id` mirrors an inbound `x-request-id` header only when
  it is 1–128 characters of `A-Z`, `a-z`, `0-9`, `.`, `_`, `:` or `-`. Any other value is
  replaced by a generated UUID, so caller-supplied text cannot inject markup, quotes or
  oversized values into logs and correlation fields.
- db0c834: **Behavior change:** Resolving a request-scoped provider on the root container now throws instead of constructing it there and caching it for the life of the application. This covers providers declared with `Scope.REQUEST` and providers that are request-scoped because they depend on one, through `container.resolve()`, `container.resolveAsync()` and therefore `app.get()`. Resolve them in the execution scope of the invocation: `getRequestContainer(c)`, `context.getContainer()` or the `runInEntrypointScope()` callback argument. Application-level error reporting on the root container falls back to the default report when the registered exception handler is request-scoped.
  
  **Behavior change:** `DiscoveryFilter.includeRequestScoped` is removed. Pass `requestScope`, an execution-scope container of the same application, to resolve request-scoped discovery hits inside that invocation. Without it they are still returned with `instance: undefined`.
  
  Add `InjectionTokenOptions.scope`. `new InjectionToken(name, { scope: Scope.REQUEST, factory })` declares a per-scope value that a runtime seeds with `setRequestInstance()`: its consumers are request-scoped in every container, even before the token is first resolved, and `factory` runs only in a scope that nothing seeded, so it can throw to say where the token resolves. A token default without `scope` is still a singleton.
  
  Adds `Container.getResolvedScope(token, moduleId?)`, the effective scope of what a resolution would return without constructing it, and `Container.sharesRootWith(other)`.
- d6f6a65: Global middleware reads a `static priority` from the `useClass` or `useExisting` target of an `APP_MIDDLEWARE` provider without constructing it, so a request-scoped middleware is ordered by its static priority instead of silently sorting at 0.
  
  **Behavior change:** a request-scoped global middleware that declares no `static priority` is reported through the container's diagnostics policy (`'log'` warns, `'throw'` fails bootstrap), because its position cannot be read at route build and it sorts at priority 0. Declare `static priority` on its class. A singleton `APP_MIDDLEWARE` whose class declares a static priority is no longer constructed at route build to read it.
- 8a3016c: `VelaFactory.create`, `bootstrap` and `ModuleLoader.load` accept a `DynamicModule` root as well as a module class, so a configurable root such as `AppModule.forRoot(...)` needs no wrapper class. `createOpenApiDocument` documents a `DynamicModule` root too.
  
  `bootstrap` registers the root, exactly as passed, as the new global `ROOT_MODULE` token next to `Container`, so any module can read the application's graph (for example to document it) without importing the root back.
  
  `countRegisteredClasses()` in `@velajs/vela/internal` reports how many classes the isolate-global metadata registry holds, for tests that prove a bootstrap path declares nothing new.
- d5a3ec8: Add `invokeScheduledJob(container, entry, invocation, options?)`, the one dispatch primitive for scheduled jobs. The Node executor, the Cloudflare adapter's cron triggers and Studio's run-now all use it: the job is resolved by its owning module in a fresh invocation scope, receives only its invocation, honors `ScheduleModule.forRoot({ dispatch: { kind: 'signed' } })` through `InternalDispatcher` (the signed route runs its global guards), and a failure is reported once on the `schedule` edge and rethrown. `options.seed(scope)` lets a runtime seed request-scoped values, such as a native event token, into the job's scope. A custom runtime that fires scheduled jobs should call it.
  
  Add the optional `SCHEDULE_INVOCATION_SEED` token (`ScheduleInvocationSeed`): a runtime adapter provides it so a job fired outside its native trigger, such as Studio's run-now, gets what the trigger would have seeded into its scope. Callers pass it to `invokeScheduledJob` as `seed`.
  
  Add `CronInvocation`, `IntervalInvocation` and `ScheduleDecorator`. `@Cron` and `@Interval` are now typed method decorators: the decorated method may declare no parameter or one that accepts its invocation.
  
  Add `scheduledJobComponents(container, entry)`, which names the `@UseGuards`, `@UseInterceptors` and `@UseFilters` declarations that apply to a scheduled job and that direct dispatch never runs. `invokeScheduledJob`, `cronDialectAmbiguity`, `scheduledJobComponents` and `SCHEDULE_INVOCATION_SEED` are exported from the root `@velajs/vela` barrel; there is no `@velajs/vela/schedule` subpath yet.
  
  Add `DiscoveryFilter.deferRequestScoped`, which returns request-scoped providers as metadata-only entries without the "request-scoped ... skipped" warning. `EntrypointRegistry.build` uses it, so an application whose `@Cron` job, `@Processor` or other entrypoint class is request-scoped (for example a job that injects `CLOUDFLARE_SCHEDULED_EVENT`) no longer logs that warning at every bootstrap; dispatchers already resolve such classes per invocation.
  
  Add `cronDialectAmbiguity(meta)`, which explains why a `@Cron` expression without a `dialect` fires on different days under Vela's unix dialect and Cloudflare semantics (a numeric weekday field, or both day fields restricted: Vela's unix dialect requires both to match, while Cloudflare, like standard crontab, fires when either does), or returns `undefined`.
  
  **Behavior change:** `ScheduleNodeModule` reports such an ambiguous `@Cron` declaration at bootstrap through the diagnostics policy: it warns once in the default `'log'` mode and fails bootstrap in `'throw'` mode. Declare `{ dialect: 'cloudflare' }` for a job that also runs on Workers and write its expression for Cloudflare, or `{ dialect: 'unix' }` only for a Node-only job.
  
  **Behavior change:** direct scheduled jobs run no guards, interceptors or filters on any runtime, neither app-global nor declared on the class, method or module, as with NestJS `@Cron`. Use signed dispatch to run a job through a route's request pipeline.
  
  **Behavior change:** a directly dispatched job that declares `@UseGuards` on its class, method or module fails closed instead of running unguarded: `invokeScheduledJob` refuses it before resolving it, on Node timers, Workers cron triggers and Studio's run-now alike, rethrows the refusal and reports it through the exception reporter on the `schedule` edge: guards do not run for directly dispatched scheduled jobs — use `ScheduleModule.forRoot({ dispatch: { kind: 'signed', ... } })` or remove the guard. Signed dispatch is not refused. Declared interceptors and filters remain a bootstrap diagnostic, whose message now says that a guarded job refuses to run.
  
  **Behavior change:** a scheduled job failure is reported with `source: 'Class.method'` (for example `'Reports.nightly'`) on every runtime; the Node executor previously reported only the method name.
  
  **Behavior change:** a handler decorated with `@Cron` or `@Interval` that declares another required parameter, or whose first parameter does not accept its invocation, no longer compiles. Remove the native `(controller, env, ctx)` parameters and annotate the job's parameter as `CronInvocation` or `IntervalInvocation`. `applyDecorators` accepts these typed decorators, and `@Process(definition)`, next to any other decorator, so `applyDecorators(Cron(expression, options), SetMetadata(key, value))` composes. As in NestJS, `applyDecorators` does not check the signature of the handler it decorates: only a `@Cron`, `@Interval` or `@Process(definition)` applied directly does. A variable annotated as `MethodDecorator` can no longer hold `Cron(...)` or `Interval(...)`: annotate it as `ScheduleDecorator<CronInvocation>` (or `ScheduleDecorator<IntervalInvocation>`), or let TypeScript infer it.
  
  **Behavior change:** `ScheduleNodeModule` reports, through the diagnostics policy, a `@Cron` with neither `dialect` nor `timeZone` when the process time zone is not UTC (it runs at local time under Node but in UTC on Workers), and a scheduled job that declares `@UseGuards`, `@UseInterceptors` or `@UseFilters`, which direct dispatch never runs. The default `'log'` mode warns once per declaration; `'throw'` fails bootstrap. Declare `{ timeZone: 'UTC' }`, `{ dialect: 'cloudflare' }` or `{ timeZone: 'local' }`, and move pipeline components to a signed route.
  
  **Behavior change:** importing `ScheduleModule.forRoot({ dispatch })` with two different dispatch policies in one application fails bootstrap instead of leaving the policy a job uses ambiguous or silently keeping the first: a signed policy compares by reference, so a different kind or another signed policy object conflicts, even one that differs only in `target`, `method` or `ttlSeconds`, or one a helper builds from the same source with another captured target. Importing the same policy object again still deduplicates. Import it once, in the root module.
- 0f7e8e7: Accept a schema wherever `@Body`, `@Query`, `@Param`, `@Headers` and `@Cookie` accept a
  pipe: `@Body(schema)`, `@Query(schema)`, `@Query('page', schema)`, `@Param('id', schema)`,
  `@Headers('x-tenant', schema)` and `@Cookie('theme', schema)`. The schema can be a Zod or
  other Standard Schema, a `parse()` parser, or a `defineDto` descriptor. The decorator
  validates the value with `new ValidationPipe(schema)`, so invalid input is a 400 with the
  normalized issues, OpenAPI documents the schema, and pipes written after it receive the
  parsed output. The new `SchemaParamDecorator` type describes these overloads.
  
  **Behavior change:** a Zod schema passed to a parameter decorator used to be run as a pipe
  through its own `transform()` method, so the handler silently received a new schema object
  instead of validated data. It now validates the value and rejects invalid input with a 400.
  A Standard Schema or parser object without `transform()` used to fail with a 500 and is now
  accepted. Pipe classes and objects with a `transform()` method are still run as pipes.
- 41ec70d: Name the default provider lifetime `Scope.DEFAULT`, as Nest does.
  
  **Behavior change:** Scope.SINGLETON is renamed Scope.DEFAULT (Nest naming); no alias. Replace every `Scope.SINGLETON` with `Scope.DEFAULT`. The member's runtime value changes from `'singleton'` to `'default'`, so `getScope`, `Container.getProviderScope`, `Container.getResolvedScope`, `DiscoveryService` registrations and the conflicting-scope decorator error now report `default`. Code that compares a scope against the string `'singleton'` must compare against `Scope.DEFAULT` instead.
  
  **Behavior change:** Studio's `app.modules` provider scopes and `app.entrypoints` scopes label that lifetime `default` instead of `singleton`. `StudioProviderScope` is now `'default' | 'transient' | 'request'`, and the response validators reject `singleton`. Because an op's payload changed, `STUDIO_PROTOCOL_VERSION` is now 3 and `StudioConnection.protocolVersion` is typed as that constant. The Studio UI rejects a health probe or host connection that reports another version with its protocol-mismatch error instead of failing on the first scope label, so upgrade `@velajs/vela`, `@velajs/studio`, `@velajs/studio-ui` and `@velajs/studio-host` together.
- b265297: **Behavior change:** an `undefined` or `null` entry in a module's `imports`, `providers`, `controllers` or `exports` now fails the load with the new `UndefinedModuleError`, for example `AppModule.imports[2] is undefined — usually a circular file import; use forwardRef(() => X)`. The error exposes `moduleName`, `property` and `index`. Previously the loader failed with an unrelated `TypeError`, and `createOpenApiDocument` silently skipped the entry.
- bdfff47: **Behavior change:** a class constructor argument without a provider visible to the resolving module now fails with the new `UnresolvedDependencyError`, which names the class, its module, the argument and the fix, for example `Cannot resolve UsersController(?, AuditService) in UsersModule. Argument #0 UsersService is declared in DataModule but not exported (add it to DataModule.exports)`. The other reasons read `is exported by DataModule, which UsersModule does not import (add DataModule to UsersModule.imports)` and `is not provided in UsersModule or its imports`. Previously the same failure threw a `ModuleVisibilityError` or a plain "No provider found" error that named only the token. The original lookup error stays available as `cause`, and the error exposes `className`, `moduleId`, `parameters`, `parameterIndex`, `token` and `reason` (`not-exported`, `not-imported` or `not-provided`, with the module instance ids involved).
  
  Only the innermost constructor reports: an error raised while building one of the argument's own dependencies passes through unchanged. It covers bootstrap, request-time resolution and `ModuleRef.create()`. Direct `container.resolve(token)` calls, provider factory `inject` lists, `useExisting` aliases, `forwardRef` proxies and hidden `@Optional()` dependencies keep their existing errors. Code that caught `ModuleVisibilityError` around a class resolution should catch `UnresolvedDependencyError` and read `cause`.
- 28c7d07: **Behavior change:** A `useClass` provider now keeps the scope its class declares with `@Injectable({ scope })` unless the provider sets `scope` itself. Request-scoped classes registered through `defineProvider(token, { useClass })`, an `APP_*` `{ useClass }` provider, `ErrorsModule.forRoot({ handler })` or `app.useGlobalExceptionHandler(Class)` now get a fresh instance per request instead of one singleton shared across requests. Set `scope` on the provider to choose a different lifetime explicitly.
- 8a3016c: WebSocket gateways authenticate upgrades through dependency injection. `@WebSocketGateway({ authenticator })` names a class implementing the new `UpgradeAuthenticator` interface (`authenticate(request, context)` returns a `WebSocketUpgradeIdentity` or `false`). Each application resolves it once from the module that declares the gateway, reusing a provider that module can see or constructing the class with what that module can inject (also when another module registers it without exporting it), and serves every later upgrade with the same instance. A gateway without an authenticator still refuses every upgrade, and an authenticator that throws or returns an invalid identity refuses the upgrade. Because that one instance is built once per application, an authenticator must not be request-scoped: one that declares `Scope.REQUEST` or injects a request-scoped provider, registered or not, is a configuration error. An authenticator the declaring module cannot construct, or a request-scoped one, fails the upgrade as a server error instead of admitting it.
  
  `allowedOrigins` also accepts `(env) => origins`, read from the application's `ENV` once per application. `'*'` remains a static opt-out.
  
  Transports bind a gateway to one application with `createWebSocketUpgradeGate(container, { options, moduleId })`, which runs the credential-parameter checks, the ticket extraction, Origin and `authorizeUpgrade`, and then the authenticator.
  
  **Behavior change:** the `authenticateUpgrade` closure option of `@WebSocketGateway` is removed, with no alias. Move its body into a class, `class SessionAuthenticator implements UpgradeAuthenticator { authenticate(request, context) { ... } }`, and pass `authenticator: SessionAuthenticator`; inject what the closure captured. The `authenticateWebSocketUpgrade(options, request, room)` and `authorizeWebSocketUpgrade(options, request)` helpers are removed from `@velajs/vela/websocket`; use `createWebSocketUpgradeGate(container, gateway)` and call the returned gate with `(request, room)`.

### Patch Changes

- ff44b6a: Resolve a handler's success status in one place for responses, OpenAPI documents and
  `@CacheResponse`: an `@Endpoint` contract's status, then `@HttpCode`, otherwise 200 (204
  for an empty result). OpenAPI documents that status as before, so a 2xx documented only
  with `@ApiResponse` is listed beside the default 200 the handler still sends. Statuses are
  unchanged.
- 44efdde: `Reflector.createDecorator()` no longer generates random values when no `key` is given, so a Worker that declares typed decorators at module scope starts instead of failing with workerd's "Disallowed operation called within global scope" error. Default keys stay unique within the process, including across duplicated package copies and hot-reloaded modules.
- Updated dependencies [bacaacd]
  - @velajs/errors@1.23.0

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

## 2.0.0

### Major Changes

- b99d71a: Compose native Worker applications through modules. QueueModule now initializes transport configuration at bootstrap and publishes driver-owned native routes, removing application-written consumer bridges. Duplicate queue ownership fails at startup. Cloudflare rejects deliveries without a consumer instead of silently accepting them; existing native decorators and envelopes remain supported.
  
  Cloudflare roots accept dynamic modules and asynchronous factories. RPC server modules and injectable named clients reuse the existing schema-validated dispatcher. Deployment checks validate module queue mappings, producer declarations and RPC service bindings. A four-worker example and exact-archive runtime proof cover composition, native delivery and scheduling.

## 1.27.0

### Minor Changes

- 2addbe3: Add binary, streaming and native Response endpoint contracts with explicit media types and OpenAPI metadata. Native responses preserve their status, headers and body; stream handling retains backpressure, cancellation and producer errors without buffering.
  
  Generate native HTTP client contracts with unknown JSON results and add response, blob and stream consumption helpers. Existing JSON/text responses and multipart/URL-encoded request contracts retain their behavior.
- 2addbe3: Add optional Web API tracing and metrics with no-op defaults, validated W3C trace
  propagation, explicit request-scope context, and an OpenTelemetry bridge that uses
  application-owned tracers and meters without exporter dependencies or automatic
  network activity. HTTP instrumentation records one completion through streaming,
  cancellation, deferred work, and disposal using bounded default attributes.
  Structural HTTP client and execution observers support independent integrations.
- 2addbe3: Extend the HTTP client with injectable fetch transports, composed cancellation and timeouts, streaming response byte limits, schema-inferred response validation, and optional instrumentation hooks. Preserve URL prefix and generic-call compatibility while fixing query/fragment handling, case-insensitive headers, multipart boundaries, and Web request-body forwarding.

## 1.26.0

### Minor Changes

- efdf854: Add opt-in asynchronous response caching with explicit trusted partitions, bounded JSON replay, and generic scoped generation-based invalidation. Preserve the synchronous CacheService API and provide an independent optional KV invalidation adapter with documented eventual-consistency limits. Preserve absolute expiry during tier backfill and KV physical retention, and fence fills that race with visible invalidation.
- 4a6f5df: Add schema-bound multipart and URL-encoded endpoint bodies with native files,
  repeated fields, explicit bounded parsing, and matching OpenAPI contracts. Generate
  accurate form request types and encoding metadata, with an opt-in HTTP fetch adapter
  that preserves caller transports and request options. Existing JSON endpoints and
  Hono client exports remain compatible.

## 1.25.0

### Minor Changes

- c6a43a6: Add optional application-owned structured logging with typed immutable records,
  bounded serialization, Error causes, redaction before sinks, category thresholds,
  and lifecycle-managed subscriptions and async delivery. Existing Logger and text
  Writer behavior remains unchanged. Add GraphQL and RPC exception-report contexts.

  Bind logging to existing invocation lifetimes with protected correlation fields,
  track asynchronous sink/custom-report completion, and route default exceptions
  through the configured application logger without duplicate custom reporting.
- bbe62d4: Await typed endpoint input and output schemas, retaining distinct wire input, parsed handler input, domain result and serialized output types. Generate directional OpenAPI contracts and preserve validator implementation errors as internal failures instead of mapping every exception to 400.
- dae3654: Add portable async-aware schema parsing, inferred schema input/output helpers and DTO parseAsync while preserving synchronous DTO parsing. Normalize validation issues without forwarding vendor input values or treating validator implementation failures as client input errors.
- b9f75f5: Add read-only visible provider snapshots for module-aware wiring audits. Introspection exposes provider
  kind, class/alias wiring, effective scope and existing values without running factories, constructing
  request providers or materializing lazy modules.
- 6df1059: Add `defineSerializer` to validate domain inputs, project an explicit public
  representation and validate wire outputs with inferred types, including domain
  classes with JavaScript private state. Input and output transformations retain
  their separate source and result types.
- bdd90a1: Consume once listeners before invocation, including recursive and overlapping dispatch. Add opt-in complete event settlement while preserving the existing emit policy.

  Add schema-inferred event definitions, scoped decorated dispatch and managed deferred delivery. Resolve legacy request-scoped event listeners per invocation and preserve their declaring module.
- 1c7f635: Add explicit managed execution scopes with injectable deferred-work lifetimes,
  observable completion errors, stream-boundary coordination, and owner-qualified
  asynchronous entrypoint and pipeline component resolution. Expose the existing HTTP
  execution-context builder for optional adapters. Keep HTTP request identity separate from
  non-HTTP work, and hide typed request-key storage with JavaScript private state.
- 636ffbc: Add a stable class-owner form of `sideEffectModule` for deduplicated contributions,
  and type call-site lazy controls and asynchronous structural module options while
  preserving inferred DI factory dependencies. Document selective integration
  composition and owner-aware discovery/dispatch.

  Preserve explicit undefined values in forwarded async structural-option bags for
  consumers using exactOptionalPropertyTypes.
- f49db45: Preserve module constructor/key identity in dependency cycles and OpenAPI traversal,
  initialize each owned provider registration, and carry module ownership through
  additive metadata-only discovery APIs and entrypoint records. Existing token-level
  discovery remains supported.

  Preserve the declaring module for configured middleware and controller mounts.
  Ambiguous mounts of the same controller class in different module instances now
  fail explicitly instead of selecting the first owner.
- 4fde903: Discover seeders per owning module registration and await async resolution inside
  managed invocation scopes. Preserve sequential ordering and stop/continue behavior
  while settling deferred work before disposal. Add optional module ownership to
  seeder inventories and expose it through `vela db seed --list --json` without
  executing seeders.
- 6a1b5b3: Correct queue disposition observation to retain the first successful ack/retry, count the initial delivery separately from retries, and distinguish unknown DLQ configuration. Add per-application queue driver factories, reject unsafe rebinding, and dispose inline bindings without retaining pending jobs.
- a95951a: Add explicit Unix/Cloudflare cron dialects, UTC selection and validated schedule metadata for deployment introspection. Fix Sunday-ending ranges and numeric coercion, reject invalid timer delays, and provide native scheduled handler types while preserving exact Workers trigger matching and Node local-time defaults.
- 9e82187: Resolve Node scheduled providers asynchronously inside a fresh module-owned invocation scope for each firing. Expose typed cooperative cancellation, stop timers and drain in-flight/deferred work before shutdown disposal, and observe strict diagnostic failures through application close. Keep direct method execution, singleton lifetimes, signed re-entry and legacy instance introspection compatible.
- c5a3cb0: Preserve authentication payload through verified tenant admission while retaining
  invalidation on expiry, clear and reauthentication. Add explicit HTTP-backed
  execution-context identity binding for custom dispatchers, and add a redacting
  Secret value with runtime-private signing
  credentials. Existing authentication and signing entrypoints remain compatible.
- 6b7cf23: Add Standard Schema job definitions with inferred producer input and validated processor output. Preserve original wire input across transport, await all processor outcomes, and offer opt-in strict unmatched routing. Add awaited Cloudflare producer and per-message consumer bridge helpers that validate envelopes, use native attempts, and preserve explicit ack/retry semantics.

  Preserve processor module ownership through discovery and dispatch, resolve scoped components asynchronously, and finish managed invocation work before settling delivery.
- 5205e58: Validate WebSocket correlation envelopes and hibernation attachments, preserve live baselines after refused sends, and add bounded connection-local send admission and incoming work. Existing void send APIs and unversioned 1.x attachments remain supported.

  Drop frames still waiting on Node connection setup after overload or close. Use browser-valid private close codes and reconnect after client-side send admission failures.
- ae45689: Resolve WebSocket callbacks and live queries in managed invocation scopes with module-owned async pipeline components. Preserve explicit request-scoped gateways, discover providers without requiring bootstrap instances, share live authorization and resolver state, and use asynchronous body validation without repeating transforms. Reject ambiguous gateway and live query ownership.

### Patch Changes

- a6ef933: Await output serialization for legacy async parsers and Standard Schema DTOs,
  including array items, and reject malformed serializer metadata instead of
  passing unfiltered responses through. Existing item-per-array semantics remain.
- 77cca9e: Resolve useExisting targets from the alias's declaring module after checking visibility of the alias.
  Exported aliases can reference their module's private implementation, consumer shadowing no longer
  rewires aliases, and unqualified aliases in different modules retain their respective targets.
  Aliases to another module's unexported providers remain rejected.
- df47ea8: Keep request provider instances and synchronous cycle detection isolated by module registration,
  including after provider replacement. Detect synchronous alias cycles without overflowing the stack.
  Add optional exact-owner module IDs to provider scope, lazy-state and instance diagnostics while
  preserving explicit request seeds and asynchronous construction deduplication.
- af019bf: Dispose transient providers with their retaining request or singleton graph, preserving caller-owned
  values and seeds. Wait for owned asynchronous construction before disposal, coalesce concurrent
  teardowns and prevent new resolution during teardown while retaining container reuse after disposal.
  Keep factory-returned existing resources with their original owner and dispose each only once.
  Protect mutable container state with JavaScript private fields.
- 8a3923f: Scope controller and handler middleware to its HTTP method and route, preserving Hono onion and HEAD behavior. Defer request-scoped controller construction until handler invocation and route pipeline component construction errors through the HTTP reporting/filter boundary.

  Resolve asynchronous controller and scoped pipeline dependencies in their declaring module, including parameter pipes, without selecting another module's registration of the same class.

  Give every HTTP request and adapter route a managed invocation lifetime. Start deferred work after dispatch and wait for work plus response completion before disposing resources; retain async cleanup with native waitUntil and correctly finish HEAD/cancelled streams.

  Preserve configured middleware owners and short-circuit responses, use explicit async pipe hooks without speculative synchronous parsing, and report middleware failures before filtering using the existing request scope. Reject ambiguous controller owners instead of selecting the first registration.
- c7d108b: Capture the HTTP request context after body-limit normalization so middleware, guards, controllers, and adapters share the same readable Request and trusted identity. Keep request lifetimes active through oversized-body and body-read error reporting and cleanup.
- 54f8864: Preserve `APP_*` useExisting registrations as aliases, including their declaring
  module and inspectable target metadata. Global aliases retain singleton identity
  and request reuse, and now correctly resolve transient targets freshly instead
  of accidentally caching them in a synthetic singleton factory. Use an explicit
  singleton target when shared global state is intended.
- 363fb71: Honor originProtection.allowMissingOrigin for non-browser credentialed requests.
  The default policy and rejection of present invalid origins and invalid CORS
  preflights remain unchanged.
- de4e57e: Validate generated CRUD request bodies once in the engine, preserving schema metadata for OpenAPI without storing global validation receipts. Headless calls validate raw input independently. Keep consumeValidated as a deprecated compatibility method that returns false. Awaited CRUD identifier, body, persisted-row and response contracts use the shared async parser to avoid speculative Zod transforms. ValidationPipe adds transformAsync while preserving its synchronous transform API.
- 0765aaa: Use shared application finalization in testing, recalculate request scope after
  provider overrides, and dispose resources on failed startup and shutdown. Await
  concurrent disposal and managed test scopes. Add onClose fixture cleanup and close
  Node WebSocket test servers with their owning testing module.
- Updated dependencies [5205e58]
  - @velajs/live-protocol@1.23.0

## 1.24.0

### Minor Changes

- fe7587f: Add Standard Schema validation and operation contracts, authoritative tenant admission and audited persistence, optional Cedar authorization with exact query plans, and Web Crypto envelope/field/file encryption. Complete compound CRUD identifiers, parent scopes, structured predicates, signed cursors, page projections and post-commit delivery. Add transactional memory and Durable Object SQLite adapters, with D1/Workers and PostgreSQL conformance coverage.

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/errors@1.22.1
  - @velajs/live-protocol@1.22.1

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/errors@1.22.0
  - @velajs/live-protocol@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/errors@2.0.1
  - @velajs/live-protocol@2.0.1

## 2.0.0

Checked dependency injection, schema-bound HTTP endpoints and live queries, immutable verified identity, typed context boundaries, and read-only live inspection. Existing provider, context, lazy-loader, and live APIs require migration.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.21.0

### Minor Changes

- 7ec61f7: Harden the framework's HTTP, cache, signed-URL, storage-path, live, and WebSocket security boundaries.

  - HTTP now runs guards before argument decorators and pipes, returns 400 for malformed JSON, and applies `VelaSecurityOptions`: a 1 MiB body limit plus bounded query bytes/count/depth before middleware, with narrow streaming-route overrides.
  - Production and edge bootstraps emit explicit security warnings when global request/query limits are raised or disabled, a streaming limit is disabled, or WebSocket Origin isolation is opted out.
  - `SecurityModule` adds exact-origin CORS, credentialed state-change Origin protection, nosniff/referrer/frame/HSTS/CSP headers, and rejects wildcard origin configuration.
  - Shared response caching requires `@Cacheable()`, scopes custom keys beneath host/path/query, bypasses credentials unless a hashed principal/tenant variation is supplied, and never stores cookie-setting responses.
  - Signed URLs require explicit positive expiry, method, and purpose; use a method- and purpose-separated v2 payload; and reject empty secrets or missing expiry. Existing v1 signatures are intentionally incompatible.
  - Core no longer trusts forwarding headers for client identity. Trusted authentication guards can publish a framework-owned canonical principal/tenant identity, which throttling prefers before a context-aware custom tracker and the runtime-attested client address; unknown clients use a fail-closed shared bucket.
  - Raw Hono 5xx messages and health-indicator payloads are no longer reflected to clients; health failures retain full non-enumerable diagnostics for structured server reporting.
  - Throttler stores may return a platform-enforced allow/deny decision without fabricating an exact remaining quota; fixed backend limits fail closed when a route override does not match.
  - HTTP and WebSocket execution contexts expose the declaring module ID for module-scoped authorization.
  - Storage paths neutralize encoded traversal segments.
  - WebSocket gateways require explicit room parameters, default browser upgrades to same-origin, reject bearer-like query credentials, authenticate cookies or bounded single-use socket tickets into canonical `{ principal, tenantId, expiresAtMs }` state before allocation, support per-delivery authorization, enforce per-gateway inbound and outbound frame/room limits across direct sends, replies, local/Redis fan-out, reject invalid room ids, and fail closed when connection setup fails. Oversized output closes with 1009 and is never written.
  - WebSocket and Live identity expiry uses the explicit epoch-millisecond `expiresAtMs` field and rejects malformed or expired values. Live delivery re-runs authorization before resume and invalidation, caps sockets at 100 subscriptions and 32 rooms, caps presence metadata at 4 KiB, binds heartbeats and roster reads to transport-verified room membership, and no longer collapses distinct security callbacks into one dynamic module.

- 92b1f50: Add edge-safe, short-lived WebSocket socket tickets. Tickets use fixed-purpose HMAC claims bound to a gateway path, room, canonical principal, tenant, expiry, and generated nonce; strict verification atomically consumes the nonce through any structural `NonceStore` and fails closed for malformed, tampered, mismatched, expired, or replayed credentials.

## 1.20.0

### Minor Changes

- 1d584f8: Add the internal-dispatch seam: `InternalDispatcher.run()` re-enters the app through named routes using per-invocation HMAC-signed claims (audience-tagged, method/path/body-hash-bound, short-TTL, nonce single-use via a pluggable `NonceStore`), verified fail-closed by the new `@SignedInvocation()` guard. Shared HMAC/base64url plumbing is extracted to `crypto/hmac.ts` and reused by the existing signed-URL feature unchanged.
- 03570b1: Adopt the `ctx.run` signed re-entry seam in QueueModule and ScheduleModule, and add a queue disposition harness.

  - **Opt-in signed dispatch (default off, additive).** `QueueModule.forRoot({ dispatch: { kind: 'signed', target } })` and `ScheduleModule.forRoot({ dispatch: { kind: 'signed', target } })` re-enter a user-authored `@SignedInvocation()` route through `InternalDispatcher.run()` instead of the direct in-isolate `@Processor`/decorated-method path, so the job runs the full request pipeline (global guards/interceptors/filters). Absent (or `{ kind: 'direct' }`) keeps today's behavior exactly; `dispatch.kind` participates in the QueueModule dedup key. The schedule-node `ScheduleExecutor` reads the policy via an `@Optional` global `SCHEDULE_DISPATCH` token.
  - **Queue disposition harness** (`@velajs/vela/queue`): `observeMessage`/`observeBatch` WRAP (never mutate) a non-extensible host queue `Message` in a Proxy to record `ack`/`retry` outcomes and honestly infer `deadLettered` when the observer supplies `maxRetries` (`undefined` when unknown, never a misleading `false`). Platform-neutral testing/observability seam; not wired into any delivery path.

### Patch Changes

- 877699e: Fix `@SignedInvocation()` on handlers that declare `@Body()`. HTTP resolves handler arguments before guards (the documented NestJS-parity contract), so `@Body()` consumed the request body before `SignedInvocationGuard` could re-hash it to verify the claim's `bodyHash` — the guard's `request.clone()` then threw on the already-used stream, surfacing as a 500 instead of the intended 200/403. A new route-scoped capture middleware, composed onto every `@SignedInvocation()` route, hashes the raw body before it is consumed and publishes the digest to the guard via a request-keyed `WeakMap`; the guard prefers that captured hash and only falls back to hashing the live body when the middleware is absent (bare-guard misuse), where it now fails closed with a 403 rather than a 500. Token wire-format, guard semantics, the cross-isolate signed `InvocationTransport` path, and the args-before-guards machinery are all unchanged; bodyless invocations behave exactly as before.

## 1.19.1

### Patch Changes

- 50854e2: Modernize the package build, validation, and release toolchain.

## 1.19.0 (2026-07-11)

Exception-handler layer (roadmap phase 3): a single branded error concept, one
wire-redaction seam, and a Laravel-style reporting contract layered above the
NestJS-style exception filters.

### Added

- **`@velajs/errors` dependency** — the new sibling package vela now builds on:
  the branded `VelaError` (own+enumerable fields so it rides any wire codec /
  `structuredClone` / DO-RPC prop copy), error catalogs
  (`defineErrorCatalog`/`composeCatalogs`/`CORE_CATALOG`), and the single
  `toErrorBody` wire-redaction seam (unbranded or `internal`-coded errors never
  echo their message). Its core surface is re-exported from `@velajs/vela` so
  app authors need one import to throw branded errors, author handlers, and
  define/compose catalogs.
- **`ExceptionHandler` contract + `resolveErrorReporter`** — an optional
  application-wide handler (`report` / `dontReport` / `context` / `render`)
  consulted at every transport edge (HTTP, WS, live, queue, schedule). Reporting
  is fire-and-forget and fully contained: a broken or throwing handler (or
  `dontReport` matcher) can never mask the original error.
- **`APP_EXCEPTION_HANDLER` / `ERROR_CATALOG` tokens** — provide the handler and
  the composed catalog via module providers.
- **`ErrorsModule.forRoot({ catalogs?, handler? })`** — composes
  `[CORE_CATALOG, ...catalogs]` (eager; a duplicate code across catalogs fails
  fast with `duplicate error code`) into `ERROR_CATALOG`, and — when given —
  registers `APP_EXCEPTION_HANDLER` (`useClass` for a handler class, `useValue`
  for a handler object).
- **`app.useGlobalExceptionHandler(handler)`** — the imperative sibling of
  `ErrorsModule.forRoot({ handler })`; registers `APP_EXCEPTION_HANDLER` on the
  root container, taking effect on the next request without a rebuild.

### Changed

- **BREAKING (sanctioned wire break): the HTTP error body is now the canonical
  error object.** Uncaught controller/handler errors render as
  `{ error: { code, message, hint?, docsUrl?, details? } }` with the code's
  catalog status, replacing the prior `{ statusCode, message }` shape.
  `HttpException` object responses still ship verbatim (crud-envelope compat).
  Error reporting is now **report-first**: the reporter runs before any
  exception filter, so a filter claiming an error can no longer make it
  invisible to logging/Sentry. A new `app.onError` fallback funnels raw
  hono-middleware throws (which previously bypassed the filter tier entirely)
  through the same report + redaction path; hono's own `HTTPException`
  responses are still honored verbatim. Per the compat policy, shipped under a
  minor with no deprecation shim.

### Fixed

- **Live engine raw-message leak** — initial-subscribe resolver errors were sent
  to the browser as raw `err.message` (`src/live/live.engine.ts`); they now flow
  through `toErrorBody`, so unbranded/internal errors are redacted like every
  other edge. The WS exception frame and the report-then-rethrow queue/schedule
  dispatch paths were aligned to the same report-first + redacted-body invariant.

## 1.15.0 (2026-07-04)

Introspection seams for `@velajs/cli` (roadmap phase 3, CLI introspection):
serializable, zero-instantiation views of the app the CLI renders instead of
re-deriving framework internals.

### Added

- **`app.describeRoutes(): RouteDescription[]`** — every explicit controller
  route exactly as `build()` registered it: method AS DECLARED (`@Head()`
  reports HEAD even though Hono serves it under GET), fully composed path
  (global prefix + version segment + controller prefix + route path),
  controller name, handler name, version. Contributed routes
  (`RouteContributor`/CRUD) mount directly on Hono and are observable via
  `getHonoApp().routes`.
- **`app.getGlobalPrefix()`** — the prefix in effect ('' when none); also
  what `openapi` tooling threads into `createOpenApiDocument`.
- **`Container.getModuleDescriptions(): ModuleDescription[]`** — the loaded
  module graph (moduleId, imports, isGlobal, lazy, provider/export token
  labels), load order plus the `__root__` bucket; reads registration state
  only — safe pre/post bootstrap, never constructs, never claims lazy
  modules.
- **`describeToken(token)`** — the token-label helper vela's own errors use,
  exported for tooling.

## 1.14.0 (2026-07-04)

First-party `QueueModule` (roadmap phase 3, "the openness proof"): a whole
feature module authored on the public API alone — `defineModule` (+ `lazy`),
`createDiscoverableDecorator`, `registerEntrypointKind`, `app.entrypoints`,
`runInEntrypointScope`, `buildEntrypointExecutionContext`, `PipelineRunner` —
machine-verified by an import audit test.

### Added

- **`@velajs/vela/queue`** — platform-agnostic queue subsystem (subpath-only;
  deliberately NOT re-exported from the main barrel because
  `@velajs/cloudflare` already exports an unrelated CF-binding `QueueModule`).
  Producers: `QueueModule.forRoot({ queues: ['email'] })` + per-queue
  `QueueClient` injected via `queueToken(name)` (`add(jobName, data,
{ delayMs? })`). Consumers: `@Processor(queue)` classes with
  `@Process(jobName?)` handlers (named wins over wildcard; duplicates warn,
  first-wins). Dispatch runs each job in `runInEntrypointScope`
  (request-scoped deps rebuild per job), re-resolves processors by token
  through the async seam (lazy consumer modules — async init hooks included —
  materialize on first job), and applies scoped
  guards/interceptors/filters through the shared pipeline; unclaimed errors
  rethrow for platform retry. App-wide `APP_*` components deliberately do NOT
  run around queue jobs (cloudflare queue/scheduled parity; diverges from the
  WebSocket dispatcher — revisit framework-wide). The in-core `inline()`
  driver (edge-pure, no timers) delivers on a microtask (`immediate`) or via
  `flush()` (`manual`, rejects with `AggregateError` on unclaimed handler
  errors); platform drivers implement `QueueDriver` out-of-core and call
  `dispatchQueueJob(container, app.entrypoints, job)`. The module is
  `lazy: true` (dogfoods 1.13): consumer-only workers defer it entirely;
  an eager producer's client injection materializes it at bootstrap.
  `queues` is structural — `forRootAsync({ queues, useFactory })`.
- **`resolveScopedComponents(type, class, method, container)`** — public
  pipeline seam surfaced by the openness proof: scoped
  `@UseGuards`/`@UsePipes`/`@UseInterceptors`/`@UseFilters` resolution for
  custom dispatchers (declaration order preserved; conventions like
  closest-first filter reversal stay with the caller).
- **`EntrypointRegistry` is injectable** — the per-app registry registers
  into the container (global token) at the end of
  `callOnApplicationBootstrap()`, so providers that dispatch entrypoints
  themselves (the queue module's in-process driver binding) resolve it
  instead of needing a back-reference to the app; `container.has(...)` probes
  it safely pre-bootstrap (the queue binding falls back to
  `DiscoveryService` + `deferLazy` for deliveries during bootstrap).

## 1.13.0 (2026-07-04)

Cold-start laziness (roadmap phase 3): modules can defer their entire init to
first use, and the in-core subsystems an HTTP-only worker doesn't touch now
cost it nothing at bootstrap.

### Added

- **Lazy modules** — `@Module({ lazy: true })`, `DynamicModule.lazy`, and
  `defineModule({ lazy: true })` (also recognized per call site like
  `isGlobal`) defer a module _instance_'s entire provider/controller group:
  nothing constructs during `VelaFactory.create`. The first resolution of any
  of its tokens (injection, `app.get()`, a request hitting its controller, a
  dispatcher re-resolving an entrypoint token) claims the module; when the
  resolution stack unwinds, the group materializes and its
  `onModuleInit`/`onApplicationBootstrap` hooks replay in registration order,
  exactly once (memoized). Materialized instances join the instance flow so
  shutdown hooks stay symmetric; untouched modules get neither init nor
  shutdown hooks. Triggers during bootstrap absorb the group into the normal
  hook phases, ordered dependency-before-consumer. `useValue` reads (options
  tokens) do not trigger. Sync seams (`app.get`, the request pipeline) throw
  a descriptive error for lazy modules with async providers/hooks — reach
  those through `app.materializeLazyModules()` (the new warmup escape hatch)
  or keep them sync. Authoring contract: docs/modules.md "Lazy modules".
- **`app.materializeLazyModules()`** — materialize every still-pending lazy
  module (async-safe); warmup/eager-everything escape hatch.
- **`Container.isLazyPending(token)` / `Container.isInstantiated(token)`** —
  non-triggering diagnostics (build-time probes, cold-start regression tests).
- **`DiscoveryFilter.deferLazy`** — discovery returns providers of
  unmaterialized lazy modules as metadata-only entries (`instance:
undefined`, mirroring the request-scoped convention) instead of forcing the
  group. `EntrypointRegistry.build` uses it: declared-kind entrypoints of
  lazy modules are metadata-only in `app.entrypoints`; dispatchers that
  re-resolve by token (cloudflare cron/queue/scheduled already do)
  materialize the owning module at dispatch time. `ContributesEntrypoints`
  providers in lazy modules are materialized right before the snapshot —
  computed contributions can't defer (documented cost).

### Changed

- **`EventEmitterModule`, `ScheduleModule`, `SeederModule`, `I18nModule` are
  now lazy.** An HTTP-only worker that imports them but never emits an event,
  reads the schedule registry, runs seeders, or translates pays zero
  cold-start cost for them — no subscriber wiring pass, no `@Cron` discovery
  walk, no merged-message snapshot. Every consumer path is a trigger, so
  observable behavior is unchanged (`app.get(EventEmitter).emit(...)` wires
  subscribers first; `runSeeders()` populates the registry via hook replay).
  `WebSocketModule` and `ScheduleNodeModule` deliberately stay eager (gateway
  injection drags the WS chain in anyway; the node executor is self-driving).
- `ModuleLoader.resolveAllInstances()` skips tokens owned exclusively by lazy
  module instances; a token also registered by a non-lazy module stays on the
  eager pass. Route building no longer instantiate-probes middleware tokens
  that are lazy-pending (default priority 0) — the probe would have defeated
  i18n's deferral at route build.

## 1.12.0 (2026-07-04)

The module-model release: one blessed authoring path plus public kernel
extension points, so feature modules (websocket, storage, queue, …) are built
entirely on the public API. See `docs/modules.md` for the author contract.
Contains deliberate breaking changes (no deprecation shims); coordinated
releases of `@velajs/{storage,better-auth,testing,crud,cloudflare}` accompany
this version.

### Added

- **`defineModule`** — the single module-authoring engine: generates `forRoot`
  AND `forRootAsync` (typed `inject` inference), derives deterministic
  `stableHash` keys (`key(options)` override + explicit `key` passthrough),
  and accepts contributions (providers/controllers/imports/exports) **as
  functions of the options** plus a standardized `global:` component slot.
  `ConfigurableModuleBuilder` is now a thin adapter over it (unchanged API).
- **Authoring primitives**: `lazyProvider` (memoized deferred thunk — replaces
  the hand-rolled `(...deps)=>()=>fn(...deps)` closures), `provideGlobal`
  (the one `APP_*` wiring idiom), `sideEffectModule` (first-class
  contribution-only modules; supported form of the i18n empty-marker trick),
  `moduleToken`, `moduleKey`.
- **`DiscoveryService` + `createDiscoverableDecorator`** — public
  decorator-driven discovery (`providersWithMeta`, `methodsWithMeta`,
  `getProviders`) backed by a reverse metadata index inside
  `MetadataRegistry`; honors container diagnostics in one place;
  request-scoped providers are surfaced but not materialized (opt in with
  `includeRequestScoped`). The event-emitter, schedule, and websocket
  bootstrap scans now all run through it.
- **Open entrypoint registry** — `registerEntrypointKind({ kind, metaKey,
level })`, the `ContributesEntrypoints` interface, and per-application
  `app.entrypoints` (`ofKind`/`kinds`/`all`), built at the end of
  `callOnApplicationBootstrap()` so slim bootstrap paths (Cloudflare Durable
  Objects) get it too. Transports query entrypoints instead of module
  internals; a new kind (queue, cron, CLI) needs **zero core changes**.
- **`RouteContributor`** — public metadata-claimed route generation
  (`registerRouteContributor`), consulted after explicit routes and during
  OpenAPI generation with verb-level merge. Replaces the internal CrudBridge.
- **`RuntimeAdapter`** — `VelaFactory.create(module, { adapters: [...] })`
  with `requestMiddleware` (prepended to the global chain), `onBootstrap`
  (after lifecycle + entrypoints, before routes) and `onRoutesBuilt` hooks.
- **`PipelineRunner`** — the shared guard → pipe → interceptor execution core
  used by HTTP and WebSocket dispatch (and any custom dispatcher);
  configurable args/guards order, transport-specific guard-rejection error.
- **`Container.replaceProvider(provider, { buckets })`** — supported
  force-replace across module buckets (what test harnesses need).
- **`buildEntrypointExecutionContext(kind, class, handler, payload)`** — the
  entrypoint sibling of the HTTP/WS execution contexts, so guards/
  interceptors/filters written against `getClass()`/`getHandler()`/`getType()`
  run unchanged around queue batches, scheduled ticks, and custom kinds
  (`EntrypointExecutionContext.getPayload()`). `@velajs/cloudflare` dispatches
  queue/scheduled handlers through `PipelineRunner` with consumer-scoped
  components (HTTP-global components deliberately do not apply; unclaimed
  errors rethrow to preserve platform retry semantics).
- **`runInEntrypointScope(container, fn)`** — the non-HTTP dispatch scope
  primitive: runs one unit of work (queue batch, scheduled tick, RPC call) in
  a fresh request-scoped child with LIFO disposal — the per-request-child
  equivalent for entrypoint dispatchers. `@velajs/cloudflare`'s queue and
  scheduled handlers run on it (request-scoped consumer deps rebuild per
  batch/tick instead of capturing boot instances).

### Changed

- **Factory dependency visibility**: `useFactory`/`forRootAsync` `inject`
  deps now resolve from the declaring module's scope FIRST (imports and
  exports are honored), with the legacy no-requester lookup kept as fallback.
- **All in-core configurable modules are on the one engine**: `CorsModule` and
  `SeederModule` rebuilt on `defineModule` (Cors gains `forRootAsync`; both
  keep their token/key identities), `ScheduleModule`/`ScheduleNodeModule`
  normalized to zero-config `@Module` bags with parity `forRoot()` sugar.
  Builder-based modules (Config/Cache/I18n/Throttler/Http) already run on it
  through the `ConfigurableModuleBuilder` adapter.
- **Unhandled handler errors are logged**: an error no exception filter claims
  still maps to the generic 500 response, but the cause now lands in the logs
  (`console.error`, gated on container diagnostics ≠ `silent`) — closing the
  silent-500 gap.
- **`WebSocketModule`** rebuilt on `defineModule`: registry → driver → server
  construction moved into chained provider factories (single shared registry
  preserved; everything materializes at bootstrap), deterministic key
  `ws#<sync-kind>` — **two identical `forRoot()` calls now dedup**
  (HMR-idempotent; pass explicit `key` for exotic multi-instance),
  `forRootAsync` available. `WsDispatcher` contributes `'websocket'`
  entrypoints; `registerWebSocketGateways` consumes
  `app.entrypoints.ofKind('websocket')`.

### Breaking

- **`WS_MODULE_OPTIONS`** is now a typed `InjectionToken` (was the raw string
  `'vela:ws-module-options'`).
- **`ComponentManager`** is stateless: `init()` and the process-global
  container are gone; `resolve*` methods require an explicit container;
  `getComponents` replaced by `getScopedComponents` (controller + handler
  only — app-wide components have one source: `RouteManager`).
  `registerGlobal`/`MetadataRegistry.getGlobal` (a dead tier with no readers
  on the request path) are removed; `MetadataRegistry.clear()` is now a
  no-op.
- **CrudBridge removed** (`registerCrudBridge`/`getCrudBridge` and the
  `/internal` exports): use `registerRouteContributor`. `@velajs/crud`
  migrates in its coordinated release.
- `forRootAsync` structural fields (non-async keys passed alongside
  `useFactory`) now merge under the resolved options.

## 1.10.0 (2026-07-01)

### Added

- **WebSocket support** (`@velajs/vela/websocket` + `@velajs/vela/websocket-node`): `@WebSocketGateway`, `@SubscribeMessage`, gateways run through the same global guard/pipe/interceptor/filter tiers as HTTP (`RouteManager.getGlobalComponents()`).

- **`ConfigurableModuleBuilder`** (NestJS-parity) + the lower-level `defineConfigurableModule` engine. Generates `forRoot`/`forRootAsync` (with `key`, `global`, `useClass`/`useExisting` async options, and the options token) from a tiny spec, so a new module is just its tokens + options type + service + a `@Module({...})` bag — while keeping vela's module encapsulation and multi-instance `key` dedup. `CacheModule`, `ConfigModule`, `ThrottlerModule`, and `HttpModule` are migrated onto it; `@velajs/cloudflare`'s binding modules reuse the engine.
- **Opt-in ambient request access**: `getCurrentContainer()` / `getCurrentRequestContext()` + `enableAmbientContainer()`, wired via `VelaFactory.create(module, { ambientContainer: true })`. Backed by Hono's `hono/context-storage` (no `node:async_hooks` import in core); OFF by default, explicit child-container path unchanged. On Cloudflare Workers it requires the `nodejs_als` (or `nodejs_compat`) flag — validated on real workerd.
- **Container + application disposal**: `Container.dispose()` (LIFO; `Symbol.asyncDispose`/`Symbol.dispose`/`.dispose()`, idempotent), `VelaApplication.dispose()` and `Symbol.asyncDispose` (enables `await using`). The root disposes shared singletons; the per-request child container is disposed automatically at the end of each HTTP request — streaming-safe (deferred until the response body drains) and zero-overhead when a request has no request-scoped disposables.
- **Async cache stores (additive, non-breaking).** New `AsyncCacheStore` interface + `TieredCacheStore` (read-through + backfill + write-through over N sync/async tiers) in core, and `KVCacheStore` in `@velajs/cloudflare`, for a memory→KV cache. The existing synchronous `CacheStore`/`CacheService`/`CacheInterceptor` are **unchanged**; `CacheModuleOptions` gains an optional sync `store`. Use the async stores programmatically (inject under your own token).
- **i18n** at the `@velajs/vela/i18n` subpath (keeps core lean; `intl-messageformat` is an optional peer dep): `I18nModule.forRoot()` + `registerMessages()` (deep-merged, HMR-safe globalThis registry), ICU formatting, header/query/cookie locale detection. `I18nService` is request-scoped and reads the per-request locale; injecting it into a controller is safe thanks to request-scope bubbling (no `ambientContainer` flag needed).
- **Storage abstractions** at the `@velajs/vela/storage` subpath (dep-free, Web Crypto only): the `StorageDriver` contract, `expandPathTemplate`/`joinStoragePath`, and HMAC `signUrl`/`verifySignedUrl`. `@velajs/cloudflare` builds on them with a multi-disk `StorageModule` over R2 (`StorageService.put/get/delete/exists/url`, per-disk roots with `{date}`/`{year}`/… templates, bucket-by-name via `EnvService`) plus a signature-gated `StorageController` presign-proxy (R2 has no native presign).
- **Seeders** at the `@velajs/vela/seeder` subpath: `@Seeder({ order })`, `SeederModule` (`forRoot({ seeders })`), and `SeederRegistry`/`runSeeders(app)` — decorator discovery at bootstrap (mirrors `ScheduleRegistry`), each seeder run in a request-scoped child. Paired with the **new `@velajs/cli` package** (clipanion) providing `vela db seed` driven by a `vela.config.{js,mjs,ts}` app factory (Node-side; kept out of the Worker bundle).

### Changed

- **Request-scope bubbling.** A provider (including controllers, which are singletons) that transitively depends on a request-scoped provider is now automatically treated as request-scoped — rebuilt per request instead of capturing the first request's instance. Matches NestJS; computed once at bootstrap (`Container.computeEffectiveScopes`), governs caching + eager instantiation. Fixes the captive-dependency hazard for request-scoped services injected into controllers.
- **HMR-safe `MetadataRegistry`**: all backing state is now anchored on `globalThis` via `Symbol.for('vela:registry:v1')`, so a Vite dev re-eval reuses the state classes were decorated against (no split-brain: lost routes / spurious "not @Injectable" warnings / duplicated globals). No API change.
- **`CacheModule`** now accepts an optional custom sync `store` in its options.

## 1.8.1 (2026-05-14)

### Revert

- **`OnFirstRequest` lifecycle hook removed.** Shipped in 1.8.0 to bridge module-load and request-time semantics for runtime-bound state (Cloudflare bindings, etc.). In practice, consumers can achieve the same deferral with a plain `@Injectable()` service holding the state as a lazy-cached field via a getter — the idiomatic NestJS pattern, no framework primitive required. Adding a lifecycle hook with zero in-tree consumers was YAGNI; reverting before it accumulates dependents. Apps that pinned to 1.8.0 and used `OnFirstRequest` should migrate to the lazy-service pattern before upgrading.

### Notes

- 1.8.0 remains published on npm but no longer the `latest` tag.
- `OnApplicationBootstrap`, `OnModuleInit`, and the existing lifecycle hooks are unchanged.

## [1.6.0]

The exception-filter chain now reaches into attached middlewares for full NestJS parity, and a new `createLazyParamDecorator` helper closes the parameter-decorator-vs-guard ordering hazard at the public-API surface.

### Added

- **`createLazyParamDecorator((data, ctx) => T)`.** Custom parameter decorators whose factory runs the _first time the handler reads a property on the resolved value_ — not during argument extraction. Vela's argument resolver runs before guards by design (`extract args → guards → handler`), which means a `createParamDecorator` factory that depends on guard-populated state observes an empty slot. The lazy variant returns a `Proxy` whose traps invoke the factory on demand; the `get` trap short-circuits `prop === 'then'` so `await value` does not consider the proxy a thenable and therefore does not trigger eager resolution. Method results are auto-bound to the resolved real target so detached calls keep `this`; `ownKeys` + `getOwnPropertyDescriptor` are implemented so `JSON.stringify(value)` works after one access. Exported from the root barrel and from `@velajs/vela/internal` via the same surface as `createParamDecorator`. Documented in README under _Custom parameter decorators with deferred resolution_.

### Changed

- **Exception-filter chain now catches errors thrown inside vela-attached middlewares.** Previously the `APP_FILTER` / `@UseFilters` chain only handled errors thrown from `@Controller` handler methods; errors from middlewares (global, `MiddlewareConsumer.apply(...).forRoutes(...)`, and per-route attached) bypassed the chain and surfaced as Hono's outer 500. They now flow through the same filter resolution as handler exceptions, with a synthesized `ExecutionContext` whose `getClass()` returns the `VelaMiddlewareHost` marker and whose `getHandler()` returns the `Symbol.for('vela.middleware')` sentinel — `getType()` stays `'http'` for NestJS parity. Only global filters apply at the middleware boundary (per-handler `@UseFilters` requires a controller call frame); for thrown `HttpException`s with no catching filter, the chain renders the exception's own response/status (matching handler-thrown semantics). Non-`HttpException` throws with no catching filter re-throw to preserve the existing default-500 path. Non-throwing middleware paths (returning a `Response`, calling `await next()`, resolving a promise) are byte-identical to before.

## Unreleased

A sanctioned per-request injectable lands as a framework primitive, the metadata-store unification finally has its regression tests, and dynamic module identity becomes consistent — closing the last open audit item.

### New

- **Dynamic module identity is now first-class** (audit #2 — last open item, fully closed). `DynamicModule` gains an optional `key?: string`; module authors call `key: stableHash(options)` inside `forRoot()` so two distinct option sets register as distinct module instances. The DI container is bucketed per-module (`Map<moduleId, Map<Token, Registration>>`) so the same logical token can have distinct registrations in different buckets — e.g., `imports: [CacheModule.forRoot({ttl:60}), CacheModule.forRoot({ttl:120})]` now actually produces two reachable cache configs instead of silently dropping one. A consumer module that imports both throws `MultipleProvidersFoundError` with both candidate ids in the message; resolve only one and the ambiguity disappears. `[HttpModule, HttpModule.forRoot({base:X})]` registers both and the loader emits a diagnostic warning. `createModuleRef()` is removed — module authors use `{module: RealClass, key}` directly. New helpers `defineDynamicModule()` and `stableHash()` are exported from the root.

  Pre-fix this swallowed configuration silently in two places: same-class `forRoot` calls collided at `processedModules.has(class)`, and synthetic-class-per-call patterns (the old `HttpModule`) collided at the container's `if (!has(token))` provider guard. Both guards are gone.

- **`REQUEST_CONTEXT` injectable.** A request-scoped primitive carrying a stable `id` (mirrored from inbound `x-request-id` if present, else `crypto.randomUUID()`), `receivedAt`, the raw `Request`, the Hono `Context`, and a typed `set/get/has` bag for cross-cutting metadata. Seeded by `RouteManager` into each per-request child container; resolves through `@Inject(REQUEST_CONTEXT)` from any request-scoped service. No `AsyncLocalStorage` — edge-runtime contract intact (verified live under workerd via `pnpm test:workers`).

  ```ts
  import { Inject, Injectable, Scope, REQUEST_CONTEXT } from "@velajs/vela";
  import type { RequestContext } from "@velajs/vela";

  @Injectable({ scope: Scope.REQUEST })
  class TenantResolver {
    constructor(
      @Inject(REQUEST_CONTEXT) private readonly ctx: RequestContext
    ) {}
    resolve() {
      return this.ctx.hono.req.header("x-tenant") ?? "default";
    }
  }
  ```

### Breaking

- **`createModuleRef()` removed.** The synthetic-class-per-`forRoot()` workaround is gone; modules use `{ module: RealClass, key }` instead. First-party modules (`HttpModule`, `CacheModule`, `ConfigModule`, `ThrottlerModule`, `CorsModule`) are migrated. Sibling consumers (`@velajs/cloudflare`, `@velajs/crud`) need to switch from `createModuleRef('${name}_${key}')` to `key: ...` on the DynamicModule.
- **Container provider storage shape changed.** `Container.providers` is now `Map<moduleId, Map<Token, Registration>>` instead of flat. `providerOrigin` is removed (origin is now `declaringModuleId` on each `ProviderRegistration`). `assertVisible` is removed (its role is subsumed by lookup-or-throw in `resolve`). `Container.has(token)` is preserved (any-bucket scan); a new `Container.hasInScope(token, moduleId)` is the strict variant. `resolveAll(token)` is now a real walk across reachable buckets, not a stub. New error: `MultipleProvidersFoundError` when an imports walk yields >1 candidate. New constant: `ROOT_MODULE_ID = '__root__'` (sentinel bucket for bootstrap primitives and sandbox registrations).

### Internal cleanup

- **Metadata stacking + funnel coverage** (audit #8 follow-up). New `metadata-stacking.test.ts` asserts `appendCustomHandlerMeta` is order-deterministic, `Reflect.defineMetadata` round-trips through `MetadataRegistry`'s typed slots, `MetadataRegistry.reset()` clears `classMeta`/`handlerMeta`, and class+handler `@SetMetadata` on the same key remain independent.
- **`NestModule.configure()` regression coverage** (audit #4 follow-up). New `configure-resolution.test.ts` asserts configure-time DI works (modules can constructor-inject providers from their own scope), synchronous errors thrown from `configure()` propagate, and unresolvable constructor deps fail loudly rather than silently skipping middleware setup.
- **Edge-safe contract documented** (audit #7 follow-up). README now states the contract explicitly: the main export is edge-safe and audited in CI by `src/__tests__/edge-runtime-audit.test.ts`; `@velajs/vela/schedule-node` is the one opt-in Node/Bun carve-out.
- **`RouteManager` split into focused units** (audit #9 follow-up). New files `argument-resolver.ts`, `handler-executor.ts`, `response-mapper.ts`, and `instantiate.ts` carry parameter extraction, the per-request orchestration closure, response/redirect mapping, and the container-aware factory. `RouteManager` is now focused on Hono route registration and path composition. Internal-only refactor — no public API change, no behavior change.
- **Stale `WeakMap` comment removed** from `MetadataRegistry.reset()` — the WeakMap fallback was retired in 1.1.0; the comment was documentation drift.
- **`Container.setRequestInstance(token, value)`** — public method to pre-seed the per-request cache. Used by `RouteManager` to populate `REQUEST_CONTEXT` before any handler resolution runs.

## 1.3.0

Module boundaries are enforced. NestJS-shape: a service cannot resolve dependencies from a module it didn't import. Bootstrap is consolidated into a single primitive, discovery failures are diagnostically routed, and a generic plugin composer is included.

### New

- **Module visibility enforcement.** `VelaFactory.create(Mod)` checks every constructor injection: the token must be declared locally, exported by an imported module, marked `@Global`, or be an `InjectionToken` with a default factory. Throws `ModuleVisibilityError` with an actionable message on violation. Auto-registration of unknown class tokens is gone — declare every dependency in a module's `providers`. There is no opt-out flag; `ModuleRef.create()` is the sandbox escape hatch for transient instantiation.

- **`bootstrap(rootModule, options)`** — the wiring primitive shared by `VelaFactory.create`, `@velajs/testing`, and any non-HTTP consumer (CLI tools, custom runtimes). Returns `{ container, routeManager, loader }` without running lifecycle hooks or building the Hono app. `VelaFactory.create` is now a thin wrapper that calls `bootstrap()` then runs `OnModuleInit` / `OnApplicationBootstrap` and builds routes. Exported from `@velajs/vela` and `@velajs/vela/internal`.

- **Module visibility primitives.** `Container({ diagnostics })`, `ModuleScope`, `Container.registerScope`, `Container.markGlobalToken`, and `ModuleVisibilityError`. `useExisting` aliases honor visibility (alias targets the caller can't see are rejected).

- **Self-providing tokens stay visible.** `new InjectionToken('X', { factory: () => Y })` is implicitly globally visible — the token's factory IS its provider, so no explicit declaration is required.

- **Factory inject is a framework-level escape hatch.** `useFactory` provider deps (including `forRootAsync`, `registerAsync`) resolve without a module-visibility requester, so factory `inject: [...]` arrays can pull from the importing module's scope. A future `forRootAsync({ imports })` will tighten this; for now it's permissive by design.

- **Discovery diagnostics: `{ diagnostics: 'silent' | 'log' | 'throw' }`** (default `'log'`). Failed provider/controller resolution at `loader.resolveAllInstances`, schedule discovery, event-emitter discovery, and runtime job execution route through one dispatcher. `ModuleVisibilityError` always propagates regardless of mode.

- **Live Cloudflare Workers smoke tests.** `pnpm test:workers` runs vela inside workerd via `@cloudflare/vitest-pool-workers` (driven by a test-only `wrangler.toml`). Validates the edge-runtime contract end-to-end — boot, request lifecycle, per-request DI without `AsyncLocalStorage`, handler-chain order, OpenAPI mount — beyond what the static edge-audit can catch. Wired into CI alongside `pnpm test`.

- **Framework primitives are globally visible.** `Container`, `ModuleRef`, and `APP_GUARD`/`APP_PIPE`/`APP_INTERCEPTOR`/`APP_FILTER`/`APP_MIDDLEWARE` are marked global at boot — resolvable from any module without explicit imports, in both strict and non-strict mode. `ModuleRef.create()` continues to be the sandbox escape hatch (visibility check skipped for transient instantiation).

- **Plugin manifest + composer** — `definePlugin({ id, version, module, dependsOn?, metadata? })` and `composePlugins(plugins): DynamicModule` with topological sort, cycle detection, and missing-dep detection. Produces a global module that exposes a queryable `PluginRegistry` via `PLUGIN_REGISTRY_TOKEN` (`list`, `get(id)`, `dependents(id)`).

- **New types**: `ModuleScope`, `ContainerOptions`, `BootstrapOptions`, `BootstrapResult`, `Diagnostics`, `Plugin` — exported from both root and `/internal`.

### Internal cleanup

- **`Container` constructor accepts `ContainerOptions`** (`{ diagnostics? }`). Threads `requestingModuleId` through `resolve` / `resolveAsync` / `resolveAll`. Per-module scopes are tracked via `registerScope`; framework-internal globals via `markGlobalToken`. `providerOrigin: Map<Token, string>` records each provider's declaring module so constructor injections resolve from the _class's_ module, not the caller's. Visibility enforcement runs whenever a `requestingModuleId` is supplied — there is no on/off switch.

- **`ModuleLoader` registers a `ModuleScope` per module** before recursing into imports — `localProviders` includes the module class itself (so `NestModule.configure()` resolution stays inside its own scope), controllers, and every provider token. Synthetic `APP_*` tokens are marked global at mint time so RouteManager's request-time resolutions (no requester) keep working.

- **`createChild()` shares container state by reference** (providers, scopes, globals, providerOrigin); `createDetached()` copies providers + providerOrigin and shares scopes + globals. Re-registering a token on a detached container without a moduleId clears any stale `providerOrigin` so sandbox-local registrations don't inherit a misleading owner.

- **`resolveAsync` factory branch now unwraps `ForwardRef` in `inject`** (mirroring the sync `resolveFactory`). Previously asymmetric — sync path worked, async path silently failed during `loader.resolveAllInstances` and was swallowed by the discovery `try/catch`.

- **Dropped unused `Container.parent` field** (audit #10). Was assigned in `createChild()` but never read.

- **Bootstrap consolidated into `src/factory/bootstrap.ts`** — `VelaFactory.create` no longer hand-rolls the APP\_\* / consumer-middleware / global-prefix wiring sequence. Net code reduction in `factory.ts`.

## 1.1.0 (2026-04-30)

Architectural remodel: one metadata model, one storage, public surface trimmed, internal primitives exposed via a stable subpath.

### Breaking changes

- **`createApplication` removed.** Use `VelaFactory.create(AppModule)` directly.

  ```diff
  - import { createApplication } from '@velajs/vela';
  - const app = await createApplication(AppModule);
  + import { VelaFactory } from '@velajs/vela';
  + const app = await VelaFactory.create(AppModule);
  ```

- **`RequestMethod` removed; `HttpMethod` is canonical and now uppercase.** The two enums had the same purpose but different cases (`'get'` vs `'GET'`). Unified to uppercase to match HTTP spec and Hono's request `method` field.

  ```diff
  - import { RequestMethod } from '@velajs/vela';
  - .forRoutes({ path: '/api', method: RequestMethod.POST });
  + import { HttpMethod } from '@velajs/vela';
  + .forRoutes({ path: '/api', method: HttpMethod.POST });
  ```

- **`@Controller({ prefix })` removed; `@Controller({ path })` only.** `prefix` was a non-canonical alias.

  ```diff
  - @Controller({ prefix: '/users', version: 1 })
  + @Controller({ path: '/users', version: 1 })
  ```

- **`HttpModule.register` / `registerAsync` renamed to `forRoot` / `forRootAsync`.** Same for `CacheModule.registerAsync` → `forRootAsync`. Matches NestJS canonical naming and aligns the rest of the framework's dynamic-module shape.

  ```diff
  - HttpModule.register({ baseURL: '...' })
  - HttpModule.registerAsync({ ... })
  - CacheModule.registerAsync({ ... })
  + HttpModule.forRoot({ baseURL: '...' })
  + HttpModule.forRootAsync({ ... })
  + CacheModule.forRootAsync({ ... })
  ```

- **`MetadataRegistry`, `RouteManager`, `ModuleLoader`, `ComponentManager`, `Container`, `VelaApplication` (the class), `bindAppProviders`, and the `APP_*` tokens moved to a stable internal subpath.** The public root barrel still re-exports `MetadataRegistry` (used by tests for `clear()`), but plugin authors should consume framework primitives from `/internal`:

  ```diff
  - import { RouteManager, ModuleLoader, ComponentManager } from '@velajs/vela';
  + import { RouteManager, ModuleLoader, ComponentManager } from '@velajs/vela/internal';
  ```

- **`Test`, `TestingModule`, `TestingModuleBuilder` removed from `@velajs/vela`'s root barrel.** Use `@velajs/testing` (≥ 0.2.0) — it's the canonical home and was rewritten on top of `@velajs/vela/internal`.

- **`HttpException._response` typed as `string | Record<string, unknown>`** (was `string | object`). `getResponse()` now returns `Record<string, unknown>`.

- **`applyDecorators` return type** changed from the impossible-at-runtime `ClassDecorator & MethodDecorator & PropertyDecorator` intersection to a `ComposedDecorator` polymorphic shape that matches every decorator slot structurally.

- **`Reflector` API takes `ExecutionContext` directly.** Was a duck-typed `{ getClass(): Constructor; getHandler(): string|symbol }` parameter; now the real type. Existing call sites that already pass an `ExecutionContext` need no change.

- **Inverted peer dep removed**: `@velajs/vela` no longer declares `peerDependencies['@velajs/crud']`. Crud is the consumer; that line was reversed.

### New

- **`@velajs/vela/internal` subpath export.** Re-exports `MetadataRegistry`, `Container`, `ModuleRef`, `RouteManager`, `ModuleLoader`, `ComponentManager`, `VelaApplication`, `bindAppProviders`, `APP_GUARD`/`APP_PIPE`/`APP_INTERCEPTOR`/`APP_FILTER`/`APP_MIDDLEWARE`, `getModuleMetadata`, `isModule`. Stable target for plugins.

### Internal cleanup

- **One metadata storage.** Decorators no longer dual-write to a typed `MetadataRegistry` slot AND a parallel `WeakMap` polyfill. The `Reflect.metadata` polyfill now funnels into `MetadataRegistry.classMeta`/`handlerMeta`, which also backs `setCustomClassMeta`/`setCustomHandlerMeta` and the `appendCustomClassMeta`/`appendCustomHandlerMeta` helpers.
- **`MetadataRegistry.clear()`** now clears only app-time global components (the only mutable run-time slot). Decoration metadata persists across `clear()`, so tests no longer need a fallback path. Use `MetadataRegistry.reset()` for a full wipe.
- **No `!` non-null assertions** in `MetadataRegistry`. New `getOrCreate`/`getOrCreateMap`/`getOrCreateArray` helpers in `registry/util.ts`.
- **No `as unknown as` casts** in `MetadataRegistry`. Component stores are now mapped-typed instead of union-typed.
- **`Constructor` is now `abstract new (...args: any[]) => unknown`** (was the bare unsafe `Function`). Every decorator's `target` casts to `Constructor` consistently.
- **Single home for shared types**: `Type`, `Token`, `Constructor`, `ProviderOptions`, `InjectableOptions`, etc. canonical in `container/types.ts`. `ModuleOptions`, `DynamicModule`, `ModuleImport`, `AsyncModuleOptions`, `ModuleMetadata` canonical in `registry/types.ts`. `module/types.ts` is a thin re-export. The `InjectionTokenLike` duck-type and the duplicated `ProviderOptions` are gone.
- **Layering fixed**: `MiddlewareConsumer`/`MiddlewareBuilder`/`NestModule`/`RouteInfo` moved from `http/` to `module/`. `module/module-loader.ts` no longer imports from `http/`.
- **`module-loader` `new moduleClass()` footgun fixed.** `NestModule.configure()` modules are now resolved through the container, so they can have constructor-injected deps.
- **One path util** (`registry/paths.ts`: `normalizePath`, `joinPaths`, `toOpenApiPath`). Replaces 2× duplicated implementations in `http/decorators.ts`, `openapi/document.ts`, and `route.manager.ts`.
- **One `ExecutionContext` factory** (`http/execution-context.ts`: `buildExecutionContext`). Replaces 2× duplicated literal construction.
- **One `bindAppProviders` helper** (`pipeline/app-providers.ts`). Implements the NestJS APP*\* provider convention in one place; replaces 5× duplicated APP*\* wiring blocks across `factory.ts` and `testing.builder.ts`.
- **One module-graph walk** (`module/graph.ts`: `collectControllers`). Replaces the duplicate implementation in `openapi/document.ts`.
- **schedule/event-emitter/openapi decorators** now use `MetadataRegistry.appendCustomClassMeta`/`appendCustomHandlerMeta` instead of direct `Reflect.defineMetadata` calls.
- **Stub `pnpm-workspace.yaml` and `bunfig.toml` deleted** — they only set `onlyBuiltDependencies`, which lives in `package.json#pnpm`. `bun.lock` deleted; pnpm is the source of truth.

## 0.10.0 (2026-04-28)

Edge-runtime audit and AI-drift cleanup.

### Breaking changes

- **Schedule module split.** `ScheduleExecutor`, `SCHEDULE_MODULE_OPTIONS`, and `ScheduleModuleOptions` are no longer exported from `@velajs/vela`. The `setInterval`-based timer executor moved to a new opt-in sub-export at `@velajs/vela/schedule-node`. Consumers on Node or Bun should now do:

  ```ts
  import { ScheduleNodeModule } from "@velajs/vela/schedule-node";

  @Module({ imports: [ScheduleNodeModule.forRoot()], providers: [JobsService] })
  class AppModule {}
  ```

  `ScheduleModule.forRoot()` is now metadata-only — `enableTimers` is no longer accepted (drop the option entirely). `ScheduleModule.forRootAsync()` was removed (no options to async-resolve).

  Edge runtimes without `setInterval` (Cloudflare Workers, etc.) should continue to use platform cron triggers — `@velajs/cloudflare` ≥ 0.2.0 dispatches core `@Cron` jobs via its `scheduled()` handler.

- **TypeScript enums replaced with `as const` objects** for `HttpMethod`, `ParamType`, `Scope`, `RequestMethod`, and `LogLevel`. Value access (`HttpMethod.GET`) keeps working; type-position usages (`: HttpMethod`) keep working via same-name type aliases. Code that imported the enum _type_ with structural assumptions about enum runtime shape may need adjustment.

### Fixes

- `@Head()` is now HEAD-only. Previously it registered as a plain GET handler, so `GET` requests would also hit `@Head()`-decorated methods.
- Handler-level guards / pipes / interceptors / filters now key off the controller constructor instead of `${className}:${method}`, fixing a metadata collision when two controllers shared a class name (across feature modules or after minification).
- Removed an obsolete narration comment in `route.manager.ts`.

### New

- `@velajs/vela/schedule-node` — opt-in entry for Node/Bun cron and interval execution.
- `parseCron(expression)` and `CronMatcher` exported from the core for use by platform cron adapters.
- Edge-runtime audit test (`src/__tests__/edge-runtime-audit.test.ts`) — fails CI if any file under `src/` (excluding `schedule-node/`) references forbidden APIs (`node:*`, `Buffer`, `process.*`, `__dirname/__filename`, `fs/path/os/child_process`, `setInterval`, `Bun.serve`).

## 0.1.0 (2026-02-19)

Initial release.

- Decorator-based controllers with full HTTP method support
- Dependency injection with singleton, transient, and request scopes
- Module system with imports, exports, and dynamic modules
- Guards, pipes, interceptors, exception filters, and middleware
- Built-in pipes: ParseIntPipe, ParseFloatPipe, ParseBoolPipe, DefaultValuePipe, RequiredPipe, ZodValidationPipe
- 18 built-in HTTP exceptions
- Custom metadata with SetMetadata + Reflector
- Custom parameter decorators via createParamDecorator
- Route versioning
- Global prefix support
- Lifecycle hooks
- Optional hono-crud integration via `vela/crud`
- Edge runtime compatible (Cloudflare Workers, Deno, Bun, Node.js 20+)
