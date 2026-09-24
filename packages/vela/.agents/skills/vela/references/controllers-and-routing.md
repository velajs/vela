# Controllers & Routing

Controllers, method/param decorators, versioning, named routes, URL generation, and signed URLs — all on the main export `@velajs/vela`. The low-level `signUrl`/`verifySignedUrl` primitives come from `@velajs/vela/security`.

## Controllers & method decorators

```ts
import { Controller, Get, Post, Param, Body, Query, ParseIntPipe } from '@velajs/vela';

@Controller('/users')            // or @Controller({ path: '/users', version: 1, scope: Scope.REQUEST })
class UsersController {
  constructor(private readonly users: UserService) {}

  @Get()                         // GET /users
  list(@Query('search') search?: string) {
    return this.users.findAll(search);
  }

  @Get('/:id')                   // GET /users/:id
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.users.findOne(id);
  }

  @Post()
  create(@Body(CreateUser) body: ReturnType<typeof CreateUser.parse>) {
    return this.users.create(body);
  }
}
```

`@Controller` accepts a path string **or** `{ path?, version?, scope? }` (there is no `prefix` or `name` on the controller). Method decorators: `@Get @Post @Put @Patch @Delete @Options @Head @All @Sse`. Each is `@Verb(path?, options?)` where `options` is `{ name?: string }`.

`@Sse(path?)` registers a GET route that streams Server-Sent Events, as Nest's `@Sse()`. Return an async iterable (an `async *` generator) of `MessageEvent` (`{ data, id?, type?, retry? }`; non-string `data` is JSON). Each event is written as it is produced through Hono's `streamSSE`, and the iterable is closed when the client disconnects. A failure mid-stream is reported and ends the stream without sending its message. A returned `Response` is sent as is.

```ts
@Sse('/events')
async *events(): AsyncIterable<MessageEvent> {
  yield { data: { ready: true }, type: 'status' };
}
```

Return a plain value (JSON) or a `Response`. Response-shaping method decorators: `@HttpCode(201)`, `@Header('allow', 'GET,POST')` (response header, stackable), `@Redirect('/path', 302)`.

## Parameter decorators

| Decorator | Reads |
|---|---|
| `@Param(name?, schema?, ...pipes)` | path params |
| `@Query(name?, schema?, ...pipes)` | query string |
| `@Body(name?, schema?, ...pipes)` | request body (or one field) |
| `@Headers(name?, schema?, ...pipes)` | request header(s) |
| `@Cookie(name?, schema?, ...pipes)` / `@Cookies()` | cookie(s) |
| `@Ip()` | client IP (see `getClientIp` create-option) |
| `@RawBody()` | raw body as `Uint8Array` |
| `@Req()` | the platform `Request`, as Nest's `@Req()` |
| `@Ctx()` / `@Res()` | `VelaContext` (the Hono context: request helpers, response headers, cookies) |

`@Body()` parses JSON only: a body must arrive as `application/json` or a `+json` media type (parameters like `charset` are fine), otherwise the request fails with 415 `unsupported_media_type`; malformed JSON is 400 and a request without a body yields `undefined`. Send `content-type: application/json` in tests (`@velajs/testing` does this for you). Raw Hono routes can use `readJsonBody(c)` for the same rule.

Pipes attach positionally: `@Param('id', ParseIntPipe)`, `@Query('mode', new ParseEnumPipe(Mode))`. A schema in a pipe position (Standard Schema such as Zod, a `parse()` parser, or a `defineDto` descriptor) becomes `new ValidationPipe(schema)`: `@Body(CreateUser)`, `@Query('page', z.coerce.number().int().min(1))`, `@Param('id', z.uuid())`. Invalid input is a 400 with the normalized issues, OpenAPI documents the schema, and later pipes receive its parsed output. See `pipeline.md` for the pipe list. Custom factories run after guards. Use `createParamDecorator` with the actual required data argument; `createLazyParamDecorator` injects an explicit memoized thunk: declare the parameter as `() => User | undefined` and call it in the handler. Validate inside the factory; lazy decorators do not take parameter pipes. Type annotations alone do not validate the value.

## Global prefix & versioning

Set the global prefix at creation (routes are built by `VelaFactory.create`, so the app has no `setGlobalPrefix()`; read it back with `app.getGlobalPrefix()`). `globalPrefixOptions.exclude` is Nest's `setGlobalPrefix(prefix, { exclude })`: matching controller routes are served without the prefix. Each target is a string or `{ path, method }` in the middleware route grammar, matched against the controller path plus the route path:

```ts
const app = await VelaFactory.create(AppModule, {
  globalPrefix: '/api',
  globalPrefixOptions: { exclude: ['health', { path: 'webhooks/:provider', method: 'POST' }] },
});
```

Relative middleware targets resolve under the prefix and so miss excluded routes; target those with `{ path: '/health', absolute: true }` or the controller (see `pipeline.md`).

Versioning is decorator-driven (no `enableVersioning`/`VersioningType`). Set a version on the controller and override per method:

```ts
@Controller({ path: '/reports', version: 1 })   // /api/v1/reports/...
class ReportsController {
  @Get('/:id') findOne() {}                       // GET /api/v1/reports/:id

  @Version(2)
  @Get('/:id') findOneV2() {}                      // GET /api/v2/reports/:id
}
```

`version` may be a number, `VERSION_NEUTRAL`, or an array of them. `VERSION_NEUTRAL` serves the route without a version segment (`@Version([2, VERSION_NEUTRAL])` serves `/v2/...` and the bare path). The URL segment is `/v{n}`, composed as `globalPrefix + /v{version} + controllerPath + routePath`; `versioning: { prefix: 'version-' }` changes the segment text and `prefix: false` serves `/{n}`. `createOpenApiDocument(AppModule, app.getRoutePathOptions())` documents the same composed paths.

## Named routes

Name a route with the `{ name }` option. Names surface on `app.describeRoutes()`, drive URL generation, and become the OpenAPI `operationId`:

```ts
@Controller('/users')
class UsersController {
  @Get('', { name: 'users.index' })
  index() { return []; }

  @Get(':id', { name: 'users.show' })
  show(@Param('id') id: string) { return { id }; }
}
```

## URL generation — `UrlGeneratorService`

Inject `UrlGeneratorService` (registered app-wide) or resolve via `app.get(UrlGeneratorService)`:

```ts
const urls = app.get(UrlGeneratorService);

urls.urlFor('users.show', { id: '42' });                 // '/users/42'
urls.urlFor('users.index');                              // '/users'
urls.urlFor('users.show', { id: '42', tab: 'posts' });   // '/users/42?tab=posts' (leftover params → query)
urls.urlFor('users.index', undefined, { query: { page: 2 } }); // '/users?page=2'
```

`urlFor(name, params?, { query? })` fills `:param` placeholders from `params`, URL-encodes them, and turns leftover params into the query string. It throws on an unknown route name or a missing required param. Paths already include the global prefix and version segment.

### Type-safe route names

Augment `VelaRouteMap` on `@velajs/vela` for typed names + params (zero codegen). Un-augmented, names fall back to `string`:

```ts
declare module '@velajs/vela' {
  interface VelaRouteMap {
    'users.index': Record<string, never>;
    'users.show': { id: string };
  }
}
// now urls.urlFor('users.show', { id }) is fully typed
```

## Signed URLs

Protect a route with `@SignedUrl()` (adds `SignedUrlGuard`), generate signed links with `UrlGeneratorService.signedUrl`, and provide the secret via the `URL_SIGNING_SECRET` token or a string `URL_SIGNING_SECRET` in the application's `ENV` (on Workers, a Wrangler secret):

```ts
import { Controller, Get, SignedUrl, URL_SIGNING_SECRET, UrlGeneratorService } from '@velajs/vela';
import { verifySignedUrl } from '@velajs/vela/security';

@Global()
@Module({
  providers: [{ provide: URL_SIGNING_SECRET, useValue: mySigningSecret }],
  exports: [URL_SIGNING_SECRET],
})
class SecretModule {}

@Controller('/files')
class FilesController {
  @Get('download', { name: 'file.download' })
  @SignedUrl()
  download() { return { ok: true }; }
}

// generate a signed, expiring link
const urls = app.get(UrlGeneratorService);
const link = await urls.signedUrl('file.download', {}, { expiresIn: 3600 });
// requests to `link` pass the guard until it expires; tampered/expired → 403
```

`signedUrl(name, params?, { expiresIn?, secret? })` builds the URL then HMAC-signs it (Web Crypto, edge-safe — no `node:crypto`). The guard resolves the secret in order: explicit → `URL_SIGNING_SECRET` token → the string `ENV.URL_SIGNING_SECRET` (non-string values are ignored). The low-level primitives `signUrl(url, secret, { expiresIn? })` and `verifySignedUrl(url, secret)` come from `@velajs/vela/security`.
