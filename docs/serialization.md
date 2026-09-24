# Response serialization

Use `@Serialize(dto)` with `SerializerInterceptor` to parse the value returned by
a controller. The DTO's schema chooses which fields and values reach the response.
For example, an object schema that strips unknown fields can remove a stored
password from the public representation.

```ts
import { Controller, Get, Serialize, SerializerInterceptor, UseInterceptors } from '@velajs/vela';
import { defineDto } from '@velajs/vela/validation';
import { z } from 'zod';

const publicUser = defineDto(z.object({ id: z.string(), name: z.string() }));

@Controller('/users')
@UseInterceptors(SerializerInterceptor)
class Users {
  @Get()
  @Serialize(publicUser)
  list() {
    return [{ id: '1', name: 'Ada', password: 'stored-password' }];
  }
}
```

The decorator records metadata; it does not install the interceptor. Interceptors
can also be registered globally through `APP_INTERCEPTOR` or
`app.useGlobalInterceptors(new SerializerInterceptor())`.

Schemas may implement Standard Schema or the legacy `parse` API. Async validation,
refinements and transformations are awaited, including each array item. Vela
uses the shared async validation boundary. Zod uses its asynchronous parser
directly so async transforms do not run twice; other Standard Schema validators
use the standard protocol, and legacy schemas prefer `parseAsync` when present.
A missing `@Serialize`
leaves the result unchanged; malformed serialization metadata fails instead of
silently returning the unfiltered result. A controller that routes a method it
inherits unchanged serializes with the `@Serialize` an ancestor declares on it;
an override uses only its own. Output validation failures use the
existing server-error pipeline, not input-validation 400 responses.

## Preserve array and response behavior

For 1.x compatibility, `@Serialize` applies its schema to **each element** of an
array. It does not parse an array as a whole, unwrap pagination envelopes, or
automatically discover nested domain objects. A response envelope needs its own
schema. For a whole-array contract or validation after all interceptors, use
[`defineEndpoint` and `@Endpoint`](types.md).

An outer interceptor can still change a serialized result. `@Serialize` does not
change ordinary response mapping: strings become text and nullish results become
empty responses. It does not automatically update OpenAPI; declare an explicit
response schema or use an endpoint contract. See [HTTP contracts](client/HTTP.md).

## Project domain objects explicitly

Use `defineSerializer` when domain objects and wire data have different shapes.
The input schema validates the domain value, `project` builds its public
representation, and the output schema validates/transforms that representation.
Each stage executes once per call and may be asynchronous.

```ts
import { defineSerializer } from '@velajs/vela';
import { z } from 'zod';

class Account {
  #id: string;
  #createdAt: Date;

  constructor(id: string, createdAt: Date) {
    this.#id = id;
    this.#createdAt = createdAt;
  }

  publicDetails() {
    return { id: this.#id, createdAt: this.#createdAt.toISOString() };
  }
}

const accountSerializer = defineSerializer({
  input: z.instanceof(Account),
  output: z.object({ id: z.string(), createdAt: z.iso.datetime() }),
  project: (account) => account.publicDetails(),
});

const wire = await accountSerializer.serialize(new Account('a1', new Date()));
// wire: { id: string; createdAt: string }
```

`serialize` requires the input schema's input type at compile time and still
validates it at runtime. If that schema transforms a string into a domain value,
pass the original string; `project` receives the transformed domain value.
`parse(unknown)` is the dynamic boundary. The same frozen descriptor
can be supplied to `@Serialize(accountSerializer)`; its `.schema` contains the
complete pipeline. `.output` retains the original wire schema for explicit
response documentation. A projection returns the output schema's input type;
the serializer result is its transformed output type. Legacy parsers without an
input type contract validate that projection at runtime.

The serializer never reads `#private` fields, constructs domain classes, revives
JSON into instances, or traverses object graphs. Use public domain methods for
intentional exposure and domain factories for reconstruction. Repeated object
references are serialized independently. Represent cycles with identifiers in
the projection. Choose JSON-compatible output schemas and explicitly convert
dates, bigint and bytes; this helper does not install a custom JSON codec.

Descriptors contain no application or request state. If projection needs injected
services, compose the descriptor inside an ordinary provider and call its
`serialize` method from the controller. Give that provider the lifetime required
by its dependencies; do not capture request state in a global descriptor. The
descriptor does not resolve provider tokens or introduce another DI container.
