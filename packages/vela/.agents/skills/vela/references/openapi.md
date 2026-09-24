# OpenAPI

Generate an OpenAPI 3.1 document from your modules and serve it with `OpenApiModule`, or with Swagger UI, Scalar, or ReDoc. All on `@velajs/vela/openapi`.

## Serving the document with OpenApiModule

```ts
import { OpenApiModule } from '@velajs/vela/openapi';

@Module({
  imports: [OpenApiModule.forRoot({ path: '/openapi.json', info: { title: 'API', version: '1.0.0' } })],
  controllers: [UsersController],
})
export class AppModule {}
```

The route serves the application root's document (`ROOT_MODULE`, contributor paths included) under the app's global prefix, built on the first request and kept for that application; there is no `OpenApiController` to write. `path` (default `/openapi.json`) is mounted as given, outside the global prefix; the route runs no guards and leaves itself out of the document. Options: `path`, `info`, `tags`, `servers`, `securitySchemes`, `security`; `forRootAsync` resolves them through DI. `@ApiExclude()` on a controller or handler leaves it out of the document and generated clients while it is still served (`isApiExcluded(target, handler?)` reads it).

## Generating the document

`createOpenApiDocument` takes the **root module class** (not the app) and reflects controller routes:

```ts
import { createOpenApiDocument } from '@velajs/vela/openapi';

const app = await VelaFactory.create(AppModule, { globalPrefix: '/api' });

const document = createOpenApiDocument(AppModule, {
  info: { title: 'Evergreen Market API', version: '1.0.0' },
  globalPrefix: '/api',            // match the app's global prefix so paths line up
});
```

`CreateOpenApiDocumentOptions`: `info?` (`{ title?, version?, description? }`), `globalPrefix?`, `tags?` (`[{ name, description? }]`), `servers?`, `securitySchemes?`, `security?`. Defaults: `openapi: '3.1.0'`, title `'Vela API'`, version `'1.0.0'`. Paths are derived from controllers (`:id` → `{id}`); `@velajs/crud` (>= 1.18) stamps real controller routes so its paths, operationIds, and DTO component schemas come through this same walk. `RouteContributor` packages fold additional generated paths in.

## Documenting operations

```ts
import { ApiDoc, ApiTags, ApiResponse } from '@velajs/vela/openapi';

@Controller({ path: '/catalog', version: 1 })
@ApiTags('catalog')
class CatalogController {
  @Get('/items', { name: 'catalog.list', response: z.array(PublicProduct) })
  @ApiDoc({ summary: 'List products', operationId: 'listProducts' })
  @ApiResponse({ status: 404, description: 'Catalog closed', schema: Problem })
  list() { return this.products.list(); }
}
```

- `@ApiTags(...tags)` — class or method; tags merge and de-dupe.
- `@ApiDoc({ summary?, description?, operationId?, deprecated?, tags? })` — class or method.
- `@ApiResponse({ status, description, schema? })` — Nest's shape; method; stackable for multiple statuses (`status` may be a number, `'4XX'` or `'default'`). `schema` is a Standard Schema (Zod, Valibot, …) or a `defineDto` descriptor; raw JSON Schema is rejected when the decorator runs.
- The success response comes from the route: its status (POST 201, `response: null` 204, otherwise 200, or `status`/`@HttpCode`) and its `response` schema (output direction). An `@ApiResponse` for that status only describes it; one for another 2xx is listed beside it.
- Request schemas come from parameter decorators (`@Body(schema)`, `@Query(schema)`, `@Param('id', schema)`, `@Headers('x', schema)`) or a `defineRoute` contract's `params`/`query`/`body`. Array query parameters get `style: form`, `explode: true`; form routes document their media type, field `encoding` and `x-vela-body-limits`.

### operationId from the route name

If a route is named (`@Get(path, { name })`), that name becomes the OpenAPI `operationId` automatically. An explicit `@ApiDoc({ operationId })` overrides it. Naming routes therefore gives you stable, human-readable operation ids for free — see `controllers-and-routing.md`.

## Serving the docs UI

`app.mountOpenApi(options)` serves the JSON spec and one or more UIs:

```ts
app.mountOpenApi({ document, specPath: '/openapi.json' });        // default UI: Scalar at /scalar
app.mountOpenApi({ document, ui: 'swagger' });                   // Swagger UI at /docs
app.mountOpenApi({ document, ui: 'all' });                       // swagger + scalar + redoc
```

`MountOpenApiOptions`:

| Field | Default | Notes |
|---|---|---|
| `document` | — | required — the object from `createOpenApiDocument` |
| `specPath` | `/openapi.json` | where the JSON spec is served |
| `ui` | `'scalar'` | `'swagger' \| 'scalar' \| 'redoc'`, an array, or `'all'` |
| `swaggerPath` | `/docs` | Swagger UI path |
| `scalarPath` | `/scalar` | Scalar path |
| `redocPath` | `/redoc` | ReDoc path |
| `title` | — | UI page title |

Each UI is a self-contained HTML shell (CDN-loaded), so mounting docs adds no server bundling and stays edge-safe.

## Schema-bound Hono RPC

Route options (`@Post({ response })` with `@Body(schema)`) and `defineRoute` contracts are runtime-validated contracts; see `validation.md`. Both styles generate the same client. `@ApiResponse` documents a result but does not validate it; TypeScript interfaces alone carry no schema. `ContractApp<typeof routes>` (`@velajs/vela/contract`) types an `hc` client from `defineRoute` contracts without generation.

```sh
vela client generate --out src/api.generated.ts --strict
vela client generate --out src/api.generated.ts --strict --check
```

```ts
import { hc } from '@velajs/client/http';
import type { AppType } from './api.generated.js';
const api = hc<AppType>('https://api.example.com');
```

Use the server origin: generated paths already include prefix/version segments. The client entrypoint re-exports Hono's client/types; do not cast the runtime Vela Hono instance into a fabricated route schema. Missing schemas become unknown or fail `--strict`; raw Hono mounts require their own contract. Read the client package's `HTTP.md` for supported wire formats and global error responses.

Form routes emit the declared multipart/URL-encoded media type, required fields,
binary file schemas, repeated-field encoding, and `x-vela-body-limits` on the request
body. CLI generation adds a `formEncodings` value beside `AppType`. Configure
`hc<AppType>(origin, { fetch: withFormEncoding(formEncodings, suppliedFetch) })`
using the adapter from `@velajs/client/http`; Hono otherwise sends every `form`
as multipart. Wrap per-call fetch overrides too. File inputs are `File | Blob`,
handler files are native File values, and URL-encoded inputs contain only text.
Do not set multipart Content-Type yourself; fetch supplies the boundary. The
adapter preserves cancellation, credentials and caller-supplied native/browser
transports, without Expo dependencies. Custom encodings and binary JSON fail
generation rather than producing inaccurate file/string types.

Native route formats (`binary`, `stream`, `response`) emit their `contentType`
and `x-vela-response-format`. Binary/stream bodies have a binary wire schema;
no parsed JSON record type is inferred. Additional statuses can use
`@ApiResponse({ status: 206, description: 'Partial content', format: 'binary', contentType:
'application/pdf' })`. Generated native `.json()` results remain `unknown`.
Use `readHttpResponse(call, 'response' | 'blob' | 'stream')` from
`@velajs/client/http` to keep the native response, buffer a blob, or access its
unread byte stream. Choose a literal mode per call. Document JSON errors for
status narrowing; stream helpers never consume unsuccessful responses implicitly.
