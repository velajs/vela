# Runtime values and their types

Execution contexts expose the objects the runtime actually provides. HTTP accessors return a Web `Request` or Hono `Context`; WebSocket accessors return `WsClient`, a string event name, and an `unknown` payload. Custom entrypoint kinds remain supported. Accessors do not accept a result type argument. Validate unknown payloads before using application fields.

The HTTP context uses `VelaContext`, and `getHonoApp()` returns `VelaHono`. Core
knows neither application bindings nor custom middleware values: `context.env`
is an opaque object and `context.get(name)` returns `unknown`. Resolve a configured
`InjectionToken<Env>` for native platform bindings, and use a `RequestContextKey`
for typed request values. This also applies to raw routes registered directly on
the returned Hono app. Runtime-registered controllers do not acquire Hono's
static route inference; generate the HTTP RPC type from their endpoint schemas.

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
import { Body, Controller, Post, ValidationPipe, defineDto } from '@velajs/vela';

const CreateUser = defineDto(
  z.object({ name: z.string().min(1), age: z.number().int().nonnegative() }),
  { name: 'CreateUser' },
);
type CreateUser = ReturnType<typeof CreateUser.parse>;

@Controller('/users')
class UsersController {
  @Post()
  create(@Body(new ValidationPipe(CreateUser)) body: CreateUser) {
    return { name: body.name, age: body.age };
  }
}
```

The descriptor exposes `name`, the original `schema`, `parse`, and `toJSONSchema`. Parsing preserves the schema's actual output, including scalar, array, and transformed outputs. `toJSONSchema` delegates to the schema and throws explicitly if that capability is unavailable. A descriptor is not constructible and never promises that an empty class instance contains required fields.

`ValidationPipe.parser` exposes an explicitly supplied parser to route introspection. A global `ValidationPipe` can also read a schema descriptor from explicit parameter metadata. TypeScript type aliases do not survive reflection, so use the explicit parser shown above for ordinary parameter decorators. For a single checked contract spanning handler inputs, outputs, validation, and generated Hono RPC types, use `defineEndpoint` and `@Endpoint`; a standalone body parser does not check a method's TypeScript annotation against its schema.

Programmatic routes supply the descriptor directly as `ParamMetadata.metatype`. The extractor passes that value through as `unknown`; validation narrows it to a callable parser. Real classes carrying static schema metadata are also readable, but class instances are not treated as schema output.
