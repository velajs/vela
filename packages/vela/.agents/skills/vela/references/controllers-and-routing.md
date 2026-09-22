# Controllers & Routing

Controllers, method/param decorators, versioning, named routes, URL generation, and signed URLs — all on the main export `@velajs/vela`.

## Controllers & method decorators

```ts
import { Controller, Get, Post, Param, Body, Query, ParseIntPipe, ValidationPipe } from '@velajs/vela';

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
  create(@Body(new ValidationPipe(CreateUser)) body: ReturnType<typeof CreateUser.parse>) {
    return this.users.create(body);
  }
}
```

`@Controller` accepts a path string **or** `{ path?, version? }` — those are the only two options (there is no `prefix` or `name` on the controller). Method decorators: `@Get @Post @Put @Patch @Delete @Options @Head @All @Sse`. Each is `@Verb(path?, options?)` where `options` is `{ name?: string }`. `@Sse` registers as a GET route.

Return a plain value (JSON) or a `Response`. Response-shaping method decorators: `@HttpCode(201)`, `@Header('allow', 'GET,POST')` (response header, stackable), `@Redirect('/path', 302)`.

## Parameter decorators

| Decorator | Reads |
|---|---|
| `@Param(name?, ...pipes)` | path params |
| `@Query(name?, ...pipes)` | query string |
| `@Body(name?, ...pipes)` | request body (or one field) |
| `@Headers(name?)` | request header(s) |
| `@Cookie(name?)` / `@Cookies()` | cookie(s) |
| `@Ip()` | client IP (see `getClientIp` create-option) |
| `@RawBody()` | raw body as `Uint8Array` |
| `@Req()` / `@Res()` | `VelaContext` (the Hono request/response context) |

Pipes attach positionally: `@Param('id', ParseIntPipe)`, `@Query('mode', new ParseEnumPipe(Mode))`. See `pipeline.md` for the pipe list. Custom factories run after guards. Use `createParamDecorator` with the actual required data argument; `createLazyParamDecorator` injects an explicit memoized thunk: declare the parameter as `() => User | undefined` and call it in the handler. Validate inside the factory; lazy decorators do not take parameter pipes. Type annotations alone do not validate the value.

## Global prefix & versioning

Set the global prefix at creation (there is **no** `app.setGlobalPrefix()` method — use the factory option; read it back with `app.getGlobalPrefix()`):

```ts
const app = await VelaFactory.create(AppModule, { globalPrefix: '/api' });
```

Versioning is decorator-driven (no `enableVersioning`/`VersioningType`). Set a version on the controller and override per method:

```ts
@Controller({ path: '/reports', version: 1 })   // /api/v1/reports/...
class ReportsController {
  @Get('/:id') findOne() {}                       // GET /api/v1/reports/:id

  @Version(2)
  @Get('/:id') findOneV2() {}                      // GET /api/v2/reports/:id
}
```

`version` may be a number or `number[]`. The URL segment is `/v{n}`, composed as `globalPrefix + /v{version} + controllerPath + routePath`.

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

Protect a route with `@SignedUrl()` (adds `SignedUrlGuard`), generate signed links with `UrlGeneratorService.signedUrl`, and provide the secret via the `URL_SIGNING_SECRET` token or `CONFIG_ENV['URL_SIGNING_SECRET']`:

```ts
import { Controller, Get, SignedUrl, URL_SIGNING_SECRET, UrlGeneratorService, verifySignedUrl, defineProvider } from '@velajs/vela';

@Global()
@Module({
  providers: [defineProvider(URL_SIGNING_SECRET, { useValue: mySigningSecret })],
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

`signedUrl(name, params?, { expiresIn?, secret? })` builds the URL then HMAC-signs it (Web Crypto, edge-safe — no `node:crypto`). The guard resolves the secret in order: explicit → `URL_SIGNING_SECRET` token → `CONFIG_ENV`. The low-level primitives `signUrl(url, secret, { expiresIn? })` and `verifySignedUrl(url, secret)` are also exported (and re-exported from `@velajs/vela/storage`).
