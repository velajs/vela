# OpenAPI

Generate an OpenAPI 3.1 document from your modules and serve it with Swagger UI, Scalar, or ReDoc. All on `@velajs/vela`.

## Generating the document

`createOpenApiDocument` takes the **root module class** (not the app) and reflects controller routes:

```ts
import { createOpenApiDocument } from '@velajs/vela';

const app = await VelaFactory.create(AppModule, { globalPrefix: '/api' });

const document = createOpenApiDocument(AppModule, {
  info: { title: 'Evergreen Market API', version: '1.0.0' },
  globalPrefix: '/api',            // match the app's global prefix so paths line up
});
```

`CreateOpenApiDocumentOptions`: `info?` (`{ title?, version?, description? }`), `globalPrefix?`, `tags?` (`[{ name, description? }]`), `servers?`, `securitySchemes?`, `security?`. Defaults: `openapi: '3.1.0'`, title `'Vela API'`, version `'1.0.0'`. Paths are derived from controllers (`:id` → `{id}`), and `RouteContributor` packages (e.g. `@velajs/crud`) fold their generated paths in.

## Documenting operations

```ts
import { ApiDoc, ApiTags, ApiResponse } from '@velajs/vela';

@Controller({ path: '/catalog', version: 1 })
@ApiTags('catalog')
class CatalogController {
  @Get('/items', { name: 'catalog.list' })
  @ApiDoc({ summary: 'List products', operationId: 'listProducts' })
  @ApiResponse(200, { description: 'Product list', schema: PublicProductDto })
  list() { return this.products.list(); }
}
```

- `@ApiTags(...tags)` — class or method; tags merge and de-dupe.
- `@ApiDoc({ summary?, description?, operationId?, deprecated?, tags? })` — class or method.
- `@ApiResponse(status, { description, schema? })` — method; stackable for multiple statuses. `schema` accepts a Zod schema, a `createZodDto` class, or raw JSON Schema.

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

Each UI is a self-contained HTML shell (CDN-loaded), so mounting docs adds no server bundling and stays edge-safe. (`path`/`uiPath` are deprecated aliases for `specPath`/single-UI path.)
