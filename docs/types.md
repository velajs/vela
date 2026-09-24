# Runtime values and their types

Execution contexts expose the objects the runtime actually provides. HTTP accessors return a Web `Request` or Hono `Context`; WebSocket accessors return `WsClient`, a string event name, and an `unknown` payload. Custom entrypoint kinds remain supported. Accessors do not accept a result type argument. Validate unknown payloads before using application fields.

The HTTP context uses `VelaContext`, and `getHonoApp()` returns `VelaHono`. Core
knows neither application bindings nor custom middleware values: `context.env`
is an opaque object and `context.get(name)` returns `unknown`. Inject `ENV`
(`@InjectEnv()`) for native platform bindings, typed as `VelaEnv`, which
`@velajs/cloudflare` extends with the `Cloudflare.Env` that `wrangler types`
generates; use a `RequestContextKey` for typed request values. This also applies to raw routes registered directly on
the returned Hono app. Runtime-registered controllers do not acquire Hono's
static route inference; generate the HTTP RPC type from their route schemas, or
share `defineRoute` contracts with the client.

The request container is held in private storage, independently of Hono's
application variables. Use `getRequestContainer(context)`,
`executionContext.getContainer()`, or opt-in `getCurrentContainer()`; setting a
Hono variable named `container` does not alter framework scope.

## Request-local values

Use a `RequestContextKey` when a value has a known application type:

```ts
import { RequestContextKey, type RequestContext } from '@velajs/vela';

const LOCALE = new RequestContextKey<string>('locale');

function configureLocale(context: RequestContext) {
  context.set(LOCALE, 'en');
  const locale = context.get(LOCALE); // string | undefined
  return locale ?? 'en';
}
```

The key is a runtime identity, like an `InjectionToken` for a provider. Two keys with the same description remain distinct. Values are isolated to their request and disappear when the request context is collected. `set` checks values against the key's type. String and symbol keys remain available for intentionally untyped values; reading them returns `unknown` and does not accept a type argument.

## Schema descriptors

`defineDto` creates a named schema descriptor. Call `parse` to produce validated data:

```ts
import { z } from 'zod';
import { Body, Controller, Post } from '@velajs/vela';
import { defineDto } from '@velajs/vela/validation';

const CreateUser = defineDto(
  z.object({ name: z.string().min(1), age: z.number().int().nonnegative() }),
  { name: 'CreateUser' },
);
type CreateUser = ReturnType<typeof CreateUser.parse>;

@Controller('/users')
class UsersController {
  @Post()
  create(@Body(CreateUser) body: CreateUser) {
    return { name: body.name, age: body.age };
  }
}
```

The descriptor exposes `name`, the original `schema`, `parse`, and `toJSONSchema`. Parsing preserves the schema's actual output, including scalar, array, and transformed outputs. `toJSONSchema` delegates to the schema and throws explicitly if that capability is unavailable. A descriptor is not constructible and never promises that an empty class instance contains required fields.

`@Body`, `@Query`, `@Param`, `@Headers` and `@Cookie` accept a schema where they accept a pipe: `@Body(schema)`, `@Query(schema)` for the whole query object, or `@Query('page', schema)`, `@Param('id', schema)` and `@Headers('x-tenant', schema)` for one named value. The schema can be a descriptor, a Standard Schema such as Zod, or a `parse()` parser. The decorator validates the value with `new ValidationPipe(schema)`: invalid input is a 400 carrying the normalized issues, OpenAPI documents the schema, and pipes written after it receive its parsed output. Writing `new ValidationPipe(schema)` yourself is equivalent. `ValidationPipe.parser` exposes that parser to route introspection. A global `ValidationPipe` can also read a schema descriptor from explicit parameter metadata. TypeScript type aliases do not survive reflection, so pass the schema to the decorator for ordinary parameters. `@Body()` with no schema validates a parameter class that carries a static Standard Schema (`class CreateUser { static schema = z.object(…) }`, or a class that is itself a Standard Schema), with no global pipe; a global `ValidationPipe` leaves such a body to it. A parameter decorator cannot check a method's TypeScript annotation against its schema; a route's `response` option does check the handler's return type, and a `defineRoute` contract types both the handler values (`ContractBody`, `ContractQuery`, `ContractParams`) and a browser client.

Programmatic routes supply the descriptor directly as `ParamMetadata.metatype`. The extractor passes that value through as `unknown`; validation narrows it to a callable parser. Real classes carrying static schema metadata are also readable, but class instances are not treated as schema output.

### Shared asynchronous schema boundaries

`parseSchema(schema, unknown)` and `parseSchemaAsync(schema, unknown)` accept a
Standard Schema, a legacy parser, or a DTO descriptor. The first preserves a
synchronous result when the validator is synchronous; the second always returns
a promise. Both prefer Standard Schema validation, then legacy `parseAsync`, then
`parse`. The async helper uses Zod’s public `safeParseAsync` when available to
avoid the Standard adapter’s synchronous probe followed by an asynchronous retry.
Use the async helper at dispatch boundaries with asynchronous Zod refinements. Import them from `@velajs/vela/validation`
when you only need validation without the framework bootstrap.

`SchemaInput<typeof schema>` retains Standard Schema wire input types, while
`SchemaOutput<typeof schema>` retains parsed output types, including transforms.
Legacy parsers without an input contract have `unknown` input. DTO descriptors
retain the concrete underlying schema. Existing synchronous DTO `parse` calls
stay synchronous; use `dto.parseAsync(value)` for asynchronous refinements.

Invalid data throws `SchemaValidationError` with message, segmented path, and an
optional validation code. Vendor issue extensions and input values are omitted.
Exceptions thrown by Standard validators are preserved, even if they contain an
`issues` property. Legacy parsers retain their structured `issues` error
convention. Map validation failures to client errors only at input boundaries;
output validation failures indicate a server-side contract failure.

### Route response transformations

A route's `response` schema accepts both synchronous and asynchronous schemas.
The handler returns the schema's input and the route sends its output, awaiting
the transformation after interceptors. This supports projecting domain
instances with JavaScript `#private` state into plain wire data without
reflective hydration (see `defineSerializer` in
[response serialization](serialization.md)).

```ts
const Amount = defineDto(z.number().transform(async (value) => String(value)), {
  jsonSchema: { type: 'string' },
});

@Controller('/amounts')
class Amounts {
  @Post({ response: Amount })
  create(@Body(z.object({ amount: z.coerce.number() })) body: { amount: number }) {
    return body.amount; // sent as the wire string, e.g. "42"
  }
}
```

OpenAPI reads input-direction schemas for wire requests and output-direction
schemas for responses. Supply `schemaConverter(direction)` or an explicit
`jsonSchema` for projections the schema library cannot represent. Async schema
validation failures at input remain 400; exceptions thrown by validators and
response-contract failures remain server errors.
