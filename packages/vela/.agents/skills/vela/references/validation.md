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

Schemas need `parse` and `toJSONSchema`; Zod 4.4+ supplies both. Input groups are `param`, `query`, `header`, and `json`. The dispatcher validates input after guards and validates the final result after interceptors. Invalid input returns 400; invalid output returns 500. An endpoint owns its status and argument parsing, so do not combine it with parameter decorators, `@HttpCode`, or `@Redirect` on the same method. JSON is the default, even for strings and null; string outputs can opt into `format: 'text'`.

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

`defineDto` returns a frozen descriptor (`name`, `schema`, `parse`, `toJSONSchema`), not a constructor. Its parse result may be an object, array, scalar, or transformed value. JSON-schema export delegates to the supplied schema and fails explicitly when unavailable.

Type aliases disappear from reflection. Supply the parser explicitly as above; a global `ValidationPipe` cannot infer it from a body type annotation. Programmatic routes can put the descriptor in parameter `metatype`. `ValidationPipe.parser` exposes the same parser to OpenAPI. The standalone pipe does not check that the method's TypeScript annotation matches its schema; `@Endpoint` supplies that stronger contract.

`ValidationPipe` maps schema issues to `BadRequestException`. `ZodValidationPipe(schema)` directly delegates to `schema.parse` and leaves its errors unchanged.

## Output serialization

`@Serialize(descriptor)` parses handler output through `descriptor.schema` when `SerializerInterceptor` is active; arrays are parsed element-by-element. Choose a schema that strips unwanted fields. Apply `@UseInterceptors(SerializerInterceptor)` or register `defineProvider(APP_INTERCEPTOR, { useClass: SerializerInterceptor })`. The decorator alone does not activate the interceptor.

See `openapi.md` for generated HTTP contracts and the repository's `docs/types.md` for the runtime/type boundary.
