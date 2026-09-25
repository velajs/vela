# Response serialization

A route's `response` schema decides what reaches the client. The route parses
the handler's final result through it (after interceptors), so an object schema
that strips unknown fields removes a stored password from the public
representation. The same schema documents the response in OpenAPI and types
the generated client, and a handler whose return type does not match it fails
to compile. `@CacheResponse` stores the response the route sent, after the
schema stripped it, so a cache store never holds fields the schema strips, and
a hit replays that response without parsing again: change the cache
`namespace` when you tighten a response schema, or entries stored before it
keep their fields until they expire.

```ts
import { Controller, Get } from '@velajs/vela';
import { z } from 'zod';

const PublicUser = z.object({ id: z.string(), name: z.string() });

@Controller('/users')
class Users {
  @Get({ response: z.array(PublicUser) })
  list() {
    return [{ id: '1', name: 'Ada', password: 'stored-password' }];
  }
}
```

The response is parsed as a whole: declare `z.array(item)` for an array and a
schema for any pagination envelope. Schemas may implement Standard Schema, the
`parse`/`parseAsync` API, or be `defineDto` descriptors. Async validation,
refinements and transformations are awaited once; Zod's `parseAsync` runs so
async transforms do not run twice. A result the schema rejects is the
handler's bug: the route answers the redacted 500 and reports the failure with
its issues, never a client 400. `validate: false` keeps the schema for
documentation and types but sends the result unparsed.

A handler that returns a `Response` sends it as is, whatever the route
declares. `format: 'text'` sends a string; `binary`, `stream` and `response` send native bodies and take no
response schema. `response: null` declares an empty body, sent as 204 unless
the route's `status` says otherwise. A controller that routes a method it
inherits unchanged, without route options of its own, uses those of the nearest
ancestor's route for the same verb and method, `response` included; an override
uses only its own. See [HTTP contracts](client/HTTP.md).

## Project domain objects explicitly

Use `defineSerializer` when domain objects and wire data have different shapes.
The input schema validates the domain value, `project` builds its public
representation, and the output schema validates/transforms that representation.
Each stage executes once per call and may be asynchronous. A serializer is a
Standard Schema from the domain input to the wire output, so it serves as a
route's `response`: the handler returns the domain value, the route sends the
projection, and OpenAPI documents the output schema.

```ts
import { Controller, Get, Param, defineSerializer } from '@velajs/vela';
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

@Controller('/accounts')
class Accounts {
  @Get('/:id', { response: accountSerializer })
  find(@Param('id') id: string) {
    return new Account(id, new Date());
  }
}

const wire = await accountSerializer.serialize(new Account('a1', new Date()));
// wire: { id: string; createdAt: string }
```

`serialize` requires the input schema's input type at compile time and still
validates it at runtime. If that schema transforms a string into a domain value,
pass the original string; `project` receives the transformed domain value.
`parse(unknown)` is the dynamic boundary. `.output` retains the original wire
schema. A projection returns the output schema's input type; the serializer
result is its transformed output type. Legacy parsers without an input type
contract validate that projection at runtime.

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
