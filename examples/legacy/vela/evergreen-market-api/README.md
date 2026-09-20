# Evergreen Market API

Evergreen Market API is a fictional product-catalog service. It is a standalone consumer-style Vela project, not a root-package unit-test fixture. Its `package.json` installs Vela through:

```json
"@velajs/vela": "file:../.."
```

That simulates how an app consumes the package through its published entry points while still using the local checkout.

- routing: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, `ALL`, `Sse`, route versioning, global prefix
- parameters: `Param`, `Query`, `Body`, `Headers`, `Req`, `Res`, `Ip`, `Cookie`, `Cookies`, `RawBody`, custom params
- DI: class providers, `InjectionToken`, `useValue`, `useClass`, `useFactory`, optional providers, request-scoped providers
- pipeline: middleware, guards, pipes, interceptors, filters, `APP_*` providers, metadata via `SetMetadata`/`Reflector`
- modules: config, cache, CORS, event emitter, schedule registry, health checks, HTTP client, throttler
- API docs: `ApiDoc`, `ApiTags`, `ApiResponse`, `createOpenApiDocument`, `mountOpenApi`
- validation and serialization: `createZodDto`, `ValidationPipe`, `Serialize`, `SerializerInterceptor`

Install this example from the Vela repo root:

```bash
pnpm --dir examples/evergreen-market-api install
```

Run the local server:

```bash
pnpm --dir examples/evergreen-market-api dev
```

Try:

```bash
curl http://localhost:8787/api/v1/catalog/items
curl -X POST http://localhost:8787/api/v1/catalog/items \
  -H 'content-type: application/json' \
  -H 'x-api-key: secret' \
  -d '{"name":"travel mug","price":18,"tags":["kitchen"]}'
curl http://localhost:8787/openapi.json
```

Run the curl verification script against the running server:

```bash
pnpm --dir examples/evergreen-market-api curl:test
```

Use another URL if you started the server elsewhere:

```bash
BASE_URL=http://localhost:9000 pnpm --dir examples/evergreen-market-api curl:test
```

Run the smoke script:

```bash
pnpm --dir examples/evergreen-market-api smoke
```

Run the example's integration tests:

```bash
pnpm --dir examples/evergreen-market-api test
```

Type-check the example:

```bash
pnpm --dir examples/evergreen-market-api typecheck
```

For an edge-style export, use `src/worker.ts`. For tests or local composition, import `createEvergreenMarketApp()` from `src/app.ts`.
