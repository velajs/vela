# Validation & Serialization

Vela validates with **Zod** (no `class-validator`, no `class-transformer`). Everything here is on `@velajs/vela`. `zod` is your dependency; core only calls `.parse()` structurally, so it never imports zod itself.

## DTOs with `createZodDto`

Wrap a Zod schema into a DTO class. The class carries a static `.schema` and is used as a `@Body()` type:

```ts
import { z } from 'zod';
import { createZodDto } from '@velajs/vela';

const CreateProductSchema = z.object({
  name: z.string().min(1),
  price: z.number().positive(),
  tags: z.array(z.string()).default([]),
});

class CreateProductDto extends createZodDto(CreateProductSchema, { name: 'CreateProductDto' }) {}
```

`createZodDto(schema, { name? })` — `name` overrides the generated class name (surfaces in OpenAPI schema names and traces). The DTO's inferred output type is the body type.

## Validating request bodies — `ValidationPipe`

`ValidationPipe` reads the DTO's static `.schema` off the parameter's metatype and validates automatically. Register it globally (once) so every `createZodDto`-typed `@Body()` is validated:

```ts
import { ValidationPipe, APP_PIPE } from '@velajs/vela';

// Option A: provider token
@Module({ providers: [{ provide: APP_PIPE, useClass: ValidationPipe }] })
class AppModule {}

// Option B: app method
app.useGlobalPipes(new ValidationPipe());

// Option C: scoped to a handler/controller
@Post()
@UsePipes(new ValidationPipe())
create(@Body() body: CreateProductDto) { ... }
```

On a Zod failure it throws `BadRequestException` with `{ statusCode: 400, message: 'Validation failed', errors: [...zod issues] }`. If the metatype has no `.schema`, the value passes through untouched.

> `ValidationPipe` (from `@velajs/vela`, metatype-driven, structured 400) is distinct from `ZodValidationPipe` (a simpler pipe that calls `schema.parse(value)` on a schema you pass explicitly, with raw errors and no metatype lookup). Use `ValidationPipe` for DTO bodies.

Neither is auto-registered — add it yourself.

## Serialization — `@Serialize`

`@Serialize(dto)` runs the handler result through `dto.schema.parse`, stripping fields not in the schema (great for hiding internal fields). It only takes effect when `SerializerInterceptor` is active:

```ts
import { Serialize, SerializerInterceptor, UseInterceptors, createZodDto } from '@velajs/vela';

class PublicProductDto extends createZodDto(
  z.object({ id: z.number(), name: z.string(), price: z.number() }),
  { name: 'PublicProductDto' },
) {}

@Controller('/catalog')
@UseInterceptors(SerializerInterceptor)   // activate the interceptor (controller or global)
class CatalogController {
  @Get('/items/:id')
  @Serialize(PublicProductDto)            // strips fields not in PublicProductDto (e.g. `secret`)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.products.find(id);        // returns full Product incl. secret
  }
}
```

`@Serialize` is method-only and silently no-ops if `SerializerInterceptor` is not applied. For arrays, each element is parsed. Register `SerializerInterceptor` via `@UseInterceptors(SerializerInterceptor)`, or globally with `{ provide: APP_INTERCEPTOR, useClass: SerializerInterceptor }`.
