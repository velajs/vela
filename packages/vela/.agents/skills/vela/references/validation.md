# Validation & serialization

Core accepts structural parsers (`parse(unknown)`), so Zod stays an application dependency. Prefer one schema-bound endpoint when request validation, handler types, output validation, OpenAPI, and Hono RPC types must agree.

## Endpoint contract

```ts
import { Controller, Endpoint, Post, defineEndpoint } from '@velajs/vela';
import { z } from 'zod';

const createProduct = defineEndpoint({
  input: z.object({ json: z.object({ name: z.string().min(1) }) }),
  output: z.object({ id: z.string(), name: z.string() }),
  status: 201,
});

@Controller('/products')
class ProductsController {
  @Post()
  @Endpoint(createProduct)
  create(input: ReturnType<typeof createProduct.input.parse>) {
    return { id: crypto.randomUUID(), name: input.json.name };
  }
}
```

Schemas can use Standard Schema (including async refinements) or legacy parsers.
JSON Schema conversion is separate: use `defineDto` with `jsonSchema` or
`schemaConverter(direction)` when the library cannot export its wire shape.
Endpoint input docs use the input direction; response docs use the output direction. Input groups are `param`, `query`, `header`, and either `json` or `form`. The dispatcher validates input after guards and validates the final result after interceptors. Invalid input returns 400; invalid output returns 500. An endpoint owns its status, so do not combine it with `@HttpCode` or `@Redirect` on the same method. JSON is the default response, even for strings and null; string outputs can opt into `format: 'text'`.

The first parameter receives the validated input. Later parameters may use context decorators — `createParamDecorator`/`createLazyParamDecorator` decorators such as `@CurrentUser()`, plus `@Req()`, `@Res()`, `@Ip()`, and `@Cookie()` — which resolve after guards and input validation with ordinary pipe semantics and stay out of OpenAPI and generated clients:

```ts
@Get('/:id')
@Endpoint(readProduct)
read(input: z.output<typeof readProduct.input>, @CurrentUser() user: User) {
  return this.products.find(input.param.id, user.id);
}
```

`@Param()`, `@Query()`, `@Headers()`, `@Body()`, and `@RawBody()` read data the input owns and fail at startup and in OpenAPI generation (declare those values in the input schema; read raw bytes on a route without `@Endpoint`), as does any decorator on the input parameter. Do not make a controller request-scoped just to read identity; use a context decorator.

For forms, use `defineEndpoint({ input: z.object({ form: z.object({ title:
z.string(), tags: z.array(z.string()), file: z.file().optional() }) }), output,
body: { contentType: 'multipart/form-data', maxBytes: 1048576, maxFiles: 4,
maxFileBytes: 262144 } })`. URL-encoded bodies select
`application/x-www-form-urlencoded` and cannot contain files. Input wire fields
must be strings/binary files or arrays; use string transforms for handler numbers.
Make fields or the whole form optional in the schema. Repeated exact keys become
arrays even with one entry; missing fields remain absent. Required arrays need an
entry; empty client arrays send none. No nested decoding or mixed text/file unions.
Unknown fields, duplicate scalars and incorrect text/file kinds fail with 400.
Malformed forms return 400, incorrect media types 415, exceeded limits 413.
Defaults are 1 MiB total encoded bytes, 100 text entries, 64 KiB per text entry
including its UTF-8 name, 10 files, 1 MiB per file. Override positive integers via
`maxBytes`, `maxFields`, `maxFieldBytes`, `maxFiles`, `maxFileBytes`; the application
body policy still applies. `defineDto` can supply a directional binary schema
converter for other libraries. Native File values have no storage coupling.

For native outputs, omit `output` and select `format: 'binary' | 'stream' |
'response'` with optional `contentType`. Binary accepts Blob, ArrayBuffer,
Uint8Array backed by ArrayBuffer, or Response; stream accepts byte ReadableStream
or Response; response requires Response. Bare bodies use the declared status and
media type (defaults 200 and application/octet-stream). Native Response objects
keep their own status, headers and body. Locked/used bodies and invalid objects
fail before handoff; chunk encoding belongs to the producer. The mapper never
buffers or reads streams. Cancellation and producer errors remain body-reader
behavior, with the existing request scope retained until the body settles.

## Parameter decorators with named descriptors

```ts
import { Body, Post, ValidationPipe, defineDto } from '@velajs/vela';

const CreateProduct = defineDto(z.object({ name: z.string().min(1) }), { name: 'CreateProduct' });
type CreateProduct = ReturnType<typeof CreateProduct.parse>;

@Post()
create(@Body(new ValidationPipe(CreateProduct)) body: CreateProduct) {
  return body;
}
```

`defineDto` returns a frozen descriptor (`name`, `schema`, `parse`, `parseAsync`, `toJSONSchema`), not a constructor. Its parse result may be an object, array, scalar, or transformed value. JSON-schema export delegates to the supplied schema and fails explicitly when unavailable.

Type aliases disappear from reflection. Supply the parser explicitly as above; a global `ValidationPipe` cannot infer it from a body type annotation. Programmatic routes can put the descriptor in parameter `metatype`. `ValidationPipe.parser` exposes the same parser to OpenAPI. The standalone pipe does not check that the method's TypeScript annotation matches its schema; `@Endpoint` supplies that stronger contract.

`ValidationPipe` maps schema issues to `BadRequestException`. `ZodValidationPipe(schema)` directly delegates to `schema.parse` and leaves its errors unchanged.

## Output serialization

`@Serialize(descriptor)` parses handler output through `descriptor.schema` when `SerializerInterceptor` is active; arrays are parsed element-by-element. Choose a schema that strips unwanted fields. Apply `@UseInterceptors(SerializerInterceptor)` or register `defineProvider(APP_INTERCEPTOR, { useClass: SerializerInterceptor })`. The decorator alone does not activate the interceptor.

See `openapi.md` for generated HTTP contracts and the repository's `docs/types.md` for the runtime/type boundary.


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
