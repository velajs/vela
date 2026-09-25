# Validation & serialization

Core accepts structural parsers (`parse(unknown)`), so Zod stays an application dependency. A route declares its contract once: the same schemas validate requests, shape the response, document OpenAPI and type the generated client.

## Route options (the default)

```ts
import { Body, Controller, Get, Param, Post } from '@velajs/vela';
import type { SchemaOutput } from '@velajs/vela/validation';
import { z } from 'zod';

const Product = z.object({ id: z.string(), name: z.string() });
const CreateProduct = z.object({ name: z.string().min(1) });

@Controller('/products')
class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Post({ response: Product }) // 201
  create(@Body(CreateProduct) body: SchemaOutput<typeof CreateProduct>) {
    return { id: crypto.randomUUID(), name: body.name };
  }

  @Get('/:id', { response: Product })
  find(@Param('id', z.string().uuid()) id: string) {
    return this.products.find(id);
  }
}
```

Method decorators take a path, then options (`response`, `status`, `format`, `contentType`, `validate`, `body`, `name`); without a path, options come first (`@Post({ response })`; a trailing `/` in a path is significant). A handler whose return type does not match `response` fails to compile. The route parses the final result, after interceptors, through `response` (a stripping schema removes undeclared fields); a rejected result answers 500, never 400; `@CacheResponse` stores the response the route sent (after interceptors and the schema) and replays it on a hit without running the handler or parsing again. `validate: false` documents and types without parsing. With `response`, JSON is the default format, even for strings and null; `format: 'text'` sends a string; without `response` or `format`, strings are text and other values JSON, as on a route without options. A handler may always return a ready `Response`. `@Redirect` and `@Sse` combine only with options that declare the request (`body`, `name`). A decorator with `response` or `format` is a `RouteMethodDecorator<Result>` that checks the handler (not a plain `MethodDecorator`); one without them is a plain `MethodDecorator`.

Status: POST 201, `response: null` 204 (no body), every other method 200, whatever the handler returns (a `null`/`undefined` result is an empty body at that status). `status` or `@HttpCode` sets another status; declaring both fails at startup, and a route serving a `defineRoute` contract takes its `status` only (no `@HttpCode`). Each route of a handler uses its own options. Responses, OpenAPI and the response cache share this rule. A route without options serving a method its controller inherits unchanged takes those of the nearest ancestor's route for the same verb, and reads the parameters the ancestor declares on the method; an override uses only its own.

Request values: `@Body`, `@Query`, `@Param`, `@Headers` and `@Cookie` accept a schema (whole value or a named field). Invalid input answers 400 after guards. `@Body()` with no schema validates a parameter class carrying a static Standard Schema (`class CreateProduct { static schema = CreateProductSchema }` or a class that is itself a Standard Schema) without any global pipe — the whole body, or the member a named `@Body('item') item: Item` reads. It validates as the body is read, before any pipe, unless a `ValidationPipe` (or subclass) applies to the parameter (its own or a global/controller/method one); then that pipe validates it in pipe order, as in Nest, and each `ValidationPipe` that applies validates (a parameter's own beside a global one validates twice). A custom validation pipe that is not a `ValidationPipe` runs after, on the validated value — extend `ValidationPipe` instead. A global `ValidationPipe` still validates programmatic body parameters. `@Query()` returns repeated keys (`?tag=a&tag=b`) and arrays declared by the route's, the parameter's or its class's schema (any union member) as arrays (even when sent once); other keys stay strings, so a repeated scalar fails its schema. Without a schema, `@Query('role') role: string` (or number/boolean) reads the first value, `@Query('tags') tags: string[]` (no pipe) always reads an array, and an `unknown`/union parameter or an array a pipe (`ParseArrayPipe`) splits reads an array for a repeated key; `string | undefined` and `string | null` are unions, so write `role?: string` for the first value. JSON bodies require `application/json` or a `+json` media type (else 415).

## Shared `defineRoute` contracts

```ts
// contracts.ts — importable by a browser; @velajs/vela/contract has no server code
import { defineRoute } from '@velajs/vela/contract';
export const createProduct = defineRoute({
  method: 'POST',
  path: '/products', // served path, global prefix and version included
  body: CreateProduct,
  response: Product,
});
```

```ts
// server
import { Body, Controller, Post } from '@velajs/vela';
import type { ContractBody } from '@velajs/vela/contract';

@Controller('/products')
class ProductsController {
  @Post(createProduct)
  create(@Body() body: ContractBody<typeof createProduct>) {
    return { id: crypto.randomUUID(), name: body.name };
  }
}
```

```ts
// browser, no codegen
import { hc } from '@velajs/client/http';
import type { ContractApp } from '@velajs/vela/contract';

const client = hc<ContractApp<[typeof createProduct]>>(origin);
```

Contracts take `params`, `query`, `body`, one of `json` / `form` / `multipart` (encoding + limits) and the response options. Declared means enforced: the route validates each declared group (and the body's encoding and limits) once per request, after guards and before the handler, whether or not a parameter reads it; `@Body()`, `@Query()`, `@Param()` (whole or named) read the validated values, pipes still run on them, and a `ValidationPipe` never validates them again; `ContractBody`, `ContractQuery`, `ContractParams`, `ContractResponse` type them. The decorator's method must match (a type error and a runtime error), and startup fails when the contract's `path` is not the path served, when a `params` schema leaves out a served path parameter, when a named parameter reads a key its group's schema does not declare, or when a parameter adds its own schema to a declared group. Both styles emit the same OpenAPI and `vela client generate` output. `hc` sends every `form` input as multipart: for `form:` contracts pass `fetch: withFormEncoding(contractFormEncodings(routes))` (`@velajs/client/http`) so they go URL-encoded.

## Forms and uploads

Routes are JSON-only unless they opt in: `body: { multipart: { maxFiles, maxFileBytes, maxFields, maxFieldBytes, maxBytes } }` or `body: { form: { maxFields, maxFieldBytes, maxBytes } }` (contracts: `multipart:` / `form:`). Such a route accepts only that media type (else 415) and reads its body after guards, before the handler, even when no parameter reads it. Pass the form schema to `@Body(schema)`: fields are strings, files (`z.file()`) or arrays of them; use string transforms for numbers. Startup fails for fields that cannot arrive as text or files. Repeated exact keys become arrays even with one entry; missing fields stay absent. Every entry is measured first: too many fields/files or oversized entries/body answer 413; then, when a whole-body schema describes the fields (as JSON Schema), unknown fields, duplicate scalars and wrong text/file kinds answer 400; without one, any field is accepted and a repeated name becomes an array. Defaults: URL-encoded 1 MiB / 100 fields / 64 KiB per field; multipart 1 file of 1 MiB, same text limits, `maxBytes` = `maxFiles × maxFileBytes` + 1 MiB. The route's own `maxBytes` replaces the app body limit for that route (a matching `streamingOverrides` entry still wins); a default `maxBytes` never exceeds a body limit the app configures. A `Content-Length` above the limit answers 413 before guards, and any other body is read after guards, counting received bytes and cancelling at the limit, also under a streaming override (the framework buffers nothing before guards; middleware that reads the body reads it when it runs). `body: { json: { maxBytes } }` bounds a JSON route, parsed after guards even when only `@RawBody()` reads it.

## Native responses

`format: 'binary' | 'stream' | 'response'` with optional `contentType` (no `response` schema). Binary accepts Blob, ArrayBuffer, Uint8Array backed by ArrayBuffer, or Response; stream accepts an unlocked byte ReadableStream or Response; response requires Response. Bare bodies use the route status and media type (default application/octet-stream). Native Response objects keep their own status, headers and body. The mapper never buffers or reads streams.

## Named descriptors

```ts
import { Body, Controller, Post } from '@velajs/vela';
import { defineDto, type SchemaOutput } from '@velajs/vela/validation';
import { z } from 'zod';

const CreateProduct = defineDto(z.object({ name: z.string().min(1) }), { name: 'CreateProduct' });

@Controller('/products')
class ProductsController {
  @Post()
  create(@Body(CreateProduct) body: SchemaOutput<typeof CreateProduct>) {
    return body;
  }
}
```

`defineDto` returns a frozen descriptor (`name`, `schema`, `parse`, `parseAsync`, `toJSONSchema`), not a constructor; OpenAPI references it as a named component. Use `jsonSchema` or `schemaConverter(direction)` when a library cannot export its wire shape.

`@Body`, `@Query`, `@Param`, `@Headers` and `@Cookie` turn a schema argument into `new ValidationPipe(schema)`; a Zod schema is detected by its Standard Schema marker, never run as a pipe. Type aliases disappear from reflection. Programmatic routes can put the descriptor in parameter `metatype`. `ValidationPipe.parser` exposes the same parser to OpenAPI.

`ValidationPipe` maps schema issues to a 400 `BadRequestException('Validation failed', { details: { issues } })`, rendered as `{ error: { code: 'bad_request', message: 'Validation failed', details: { issues } } }` with the normalized issues (`message`, `path?`, `code?`). It is the only schema pipe; exceptions thrown by a validator itself remain server errors.

See `serialization.md` for response projections, `openapi.md` for generated HTTP contracts and the repository's `docs/types.md` for the runtime/type boundary.

## Async boundaries and validation ownership

Use `parseSchemaAsync` from `@velajs/vela/validation` for portable async boundaries;
`SchemaInput<S>` and `SchemaOutput<S>` keep wire and transformed types distinct.
`SchemaValidationError` identifies invalid input; thrown validator failures and
invalid server output remain internal errors. Only safe issue fields are exposed.
Existing DTO `parse` and pipe `transform` stay synchronous when their schema is
synchronous. DTO `parseAsync` and pipe `transformAsync` use the async boundary;
framework dispatch prefers the optional `transformAsync` pipe method. This avoids
Zod's speculative synchronous validation before an asynchronous retry.

Programmatic generated routes can attach `validationOwner: 'handler'` to their
schema metatype: a global ValidationPipe then leaves raw input to the handler,
while OpenAPI still uses the schema. Explicit schema pipes always validate.
CRUD uses this metadata because its engine owns validation for HTTP and headless
calls. Pass raw input to the engine; no global validation receipts are retained.
