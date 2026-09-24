# Typed HTTP client

`@velajs/client/http` exports Hono's `hc` client and its response helpers. Generate a contract from Vela's OpenAPI metadata, then import it in your frontend. JSON-only contracts contain only types; form contracts also export encoding metadata. No server modules are included in the browser bundle.

```sh
# In the API project (rootModule and createApp in vela.config)
vela client generate --out src/api.generated.ts --strict

# In CI: fail when the committed contract is stale
vela client generate --out src/api.generated.ts --strict --check
```

You can also generate from an exported document, without starting the app:

```sh
vela client generate --input openapi.json --out src/api.generated.ts
```

Use the server origin as the base URL: generated paths already include the app's global prefix and route versions. Both projects should enable TypeScript `strict` mode.

```ts
import { hc, parseResponse } from '@velajs/client/http';
import type { InferRequestType, InferResponseType } from '@velajs/client/http';
import type { AppType } from './api.generated';

const client = hc<AppType>('https://api.example.com', {
  init: { credentials: 'include' },
});

// For a documented GET /users/:id route:
const response = await client.users[':id'].$get({ param: { id: 'u1' } });
if (response.status === 404) {
  const error = await response.json(); // the documented 404 body
}
if (response.ok) {
  const user = await response.json(); // the documented success body
}

// For a documented POST /users accepting { name: string }:
const user = await parseResponse(client.users.$post({ json: { name: 'Ada' } }));
type CreateUser = InferRequestType<typeof client.users.$post>['json'];
type CreatedUser = InferResponseType<typeof client.users.$post, 201>;
```

`hc` also supports injectable `fetch`, shared/async headers, per-call `RequestInit`, `$url()` and `$path()`. It returns a fetch-compatible response; `parseResponse()` parses the body and throws `DetailedError` for unsuccessful responses. Path/query/header values are wire strings (query arrays use repeated keys); encode path values containing reserved characters with `encodeURIComponent`.

## Describe the server contract

A route declares its contract once, and the same schemas validate requests,
shape responses, document OpenAPI and type the generated client. Vela offers
two equivalent styles; they produce the same OpenAPI document and the same
generated client.

### Route options (the default)

Method decorators take route options after the path (or instead of it), and
parameter decorators take schemas. With Zod 4.4 or later:

```ts
import { Body, Controller, Get, Param, Post, Query } from '@velajs/vela';
import type { SchemaOutput } from '@velajs/vela/validation';
import { z } from 'zod';

const User = z.object({ id: z.string(), name: z.string() });
const CreateUser = z.object({ name: z.string().min(1) });
const ListUsers = z.object({ tag: z.array(z.string()).optional() });

@Controller('/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get({ response: z.array(User) })
  list(@Query(ListUsers) query: SchemaOutput<typeof ListUsers>) {
    return this.users.list(query.tag);
  }

  @Post({ response: User }) // 201
  create(@Body(CreateUser) body: SchemaOutput<typeof CreateUser>) {
    return { id: crypto.randomUUID(), name: body.name };
  }

  @Get('/:id', { response: User })
  find(@Param('id', z.string().uuid()) id: string) {
    return this.users.find(id);
  }
}
```

The options are `response`, `status`, `format`, `contentType`, `validate` and
`body`, plus the route `name`. A handler whose return type does not match
`response` fails to compile. The route parses the final result, after
interceptors, through `response`: a stripping schema removes undeclared fields,
and a result the schema rejects answers 500; `@CacheResponse` stores the
parsed value. With `response`, JSON is the default format, including strings
and `null`; `format: 'text'` sends a string. Without `response` or `format`, the
route sends strings as text and other values as JSON, like a route without
options. A handler may always return a ready `Response`. Invalid input returns
400, after guards. `validate: false` keeps the schema for documentation and
types without parsing the result.

A decorator with `response` or `format` checks its handler's result, so its
type is `RouteMethodDecorator<Result>` rather than `MethodDecorator`: annotate
a helper that returns one with `RouteMethodDecorator<T>`, or let TypeScript
infer it. Decorators without those options are ordinary `MethodDecorator`s.

POST answers 201, `response: null` answers 204 with no body, and every other
method answers 200, whatever the handler returns; `status` or `@HttpCode`
declares another success status (not both). Each route uses its own options,
also when one handler serves several routes. Responses, OpenAPI and the
response cache read the status the same way.

`@Body()` without a schema validates a parameter class that carries a static
Standard Schema (`class CreateUser { static schema = CreateUserSchema }`, or a
class that is itself a Standard Schema), with no global pipe; a named
`@Body('user') user: CreateUser` validates that member. A global
`ValidationPipe` leaves a value the route validated (`ArgumentMetadata.validated`)
as is. Named descriptors work too: `const BodyDto = defineDto(schema, { name:
'CreateUser' })`, then `@Body(BodyDto)`; OpenAPI then references a named
component. Erased TypeScript interfaces cannot supply schemas.

`@Query()` parses repeated keys (`?tag=a&tag=b`) and keys its schema declares as
arrays to arrays, even when a key is sent once; every other key stays a string,
so a repeated scalar reaches its schema as an array and fails validation. The
schema is the route's, the parameter's own, or its class's static schema (which
a global `ValidationPipe` validates). Without a schema, a named parameter
follows its declared type: `@Query('sort') sort: string` (or `number`,
`boolean`) receives the first value, `@Query('tags') tags: string[]` without a
pipe always receives an array, and a parameter typed `unknown` or a union
receives an array for a repeated key. Declare a schema for security-relevant
query values. OpenAPI documents array query parameters with `style: form` and
`explode: true`.

### Shared `defineRoute` contracts

`defineRoute` from `@velajs/vela/contract` declares a route's method, path and
schemas in a module a browser can import: the entry imports no server code.
Every method decorator serves a contract of its own method:

```ts
// contracts.ts — shared by server and browser
import { defineRoute } from '@velajs/vela/contract';

export const createUser = defineRoute({
  method: 'POST',
  path: '/users',
  body: CreateUser,
  response: User,
});
export const findUser = defineRoute({
  method: 'GET',
  path: '/users/:id',
  params: z.object({ id: z.string().uuid() }),
  response: User,
});

// users.controller.ts
import { type ContractBody, type ContractParams } from '@velajs/vela/contract';

@Controller('/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post(createUser)
  create(@Body() body: ContractBody<typeof createUser>) {
    return { id: crypto.randomUUID(), name: body.name };
  }

  @Get('/:id', findUser)
  find(@Param() params: ContractParams<typeof findUser>) {
    return this.users.find(params.id);
  }
}
```

A contract takes `params`, `query` and `body` schemas, one of `json`, `form` or
`multipart` for the body's encoding and limits, and the response options above.
The route validates each group once per request; `@Body()`, `@Query()` and
`@Param()` (whole or named) read the validated values. The decorator's method
must match the contract's, and the application fails to start when the
contract's `path` is not the path the route serves (global prefix and version
included), or when the route adds `@HttpCode`: `ContractApp` clients are typed
with the contract's `status`, so declare it there.

Without code generation, `ContractApp` types an `hc` client from contracts:

```ts
import { hc } from '@velajs/client/http';
import type { ContractApp } from '@velajs/vela/contract';
import { createUser, findUser } from './contracts';

const client = hc<ContractApp<[typeof createUser, typeof findUser]>>(origin);
const created = await client.users.$post({ json: { name: 'Ada' } }); // status 201
const user = await (await client.users[':id'].$get({ param: { id } })).json();
```

`ContractApp` types wire values as the generator does: path and query values
are strings (string literal unions stay literal), files are `File | Blob`, JSON
bodies are the schema's input and responses its JSON-parsed output.

`hc` sends every `form` input as multipart, and a `form:` contract accepts only
URL-encoded bodies (415 otherwise). `contractFormEncodings(routes)` lists the
contracts' form encodings for `withFormEncoding`, which encodes those calls:

```ts
import { hc, withFormEncoding } from '@velajs/client/http';
import { contractFormEncodings, type ContractApp } from '@velajs/vela/contract';

const client = hc<ContractApp<typeof routes>>(origin, {
  fetch: withFormEncoding(contractFormEncodings(routes)),
});
```

### Generated clients

`@ApiResponse({ status, description, schema })` documents another status, such
as an error body; the schema is a Standard Schema or `defineDto` descriptor,
converted to JSON Schema. It documents without validating. For the success
status it only describes the route's own response.

The generated `AppType` uses Hono's schema types. `Schemas` exports named DTO/component types. Missing schemas become `unknown` with diagnostics on stderr; `--strict` fails instead. Unsupported path syntax and parameter serialization fail generation. Native response media types retain an unknown JSON boundary. Route schemas supply runtime validation; documentation-only schemas remain declarations. Imported OpenAPI files are decoded before generation, and malformed nested fields fail with a path diagnostic.

The generator supports JSON, multipart, and URL-encoded request bodies, JSON/text and native binary/stream responses, component schema references, object properties, arrays, enums, unions/intersections, and nullable JSON values. Form fields have the concrete wire shapes described below. Use separate input/output definitions for `readOnly` or `writeOnly` fields. Cookie parameters, external references and parameter serialization other than repeated query keys require a separately authored contract. Paths with a trailing slash (other than `/`) or reserved `hc` segments such as `index` and `then` are rejected; use `@Get()` for a controller's base route. GET/HEAD request bodies are rejected because `hc` does not send them. Contributed routes need OpenAPI metadata from their contributor; raw Hono mounts are not inferred.

Declare global guard/filter responses explicitly when needed:

```ts
import type { ApplyGlobalResponse } from '@velajs/client/http';
type ApiWithErrors = ApplyGlobalResponse<AppType, {
  401: { json: { error: { code: string; message: string } } };
  500: { json: { error: { code: string; message: string } } };
}>;
const authenticated = hc<ApiWithErrors>('https://api.example.com');
```

HTTP calls through `hc` are ordinary requests. Continue using `LiveClient.mutate()` for cursor-gated optimistic updates and offline replay; live subscription contracts remain separate.

## Form bodies and uploads

Routes read JSON by default and answer 415 for any other media type. A route
opts into one form encoding with `body: { multipart: limits }` or
`body: { form: limits }` (a contract uses `multipart:` or `form:` directly),
and the body schema supplies the handler's parsed types and OpenAPI's wire
types:

```ts
const Upload = z.object({
  kind: z.enum(['avatar', 'banner']),
  ownerId: z.string().uuid(),
  description: z.string().max(2000).optional(),
  revision: z.string().regex(/^\d+$/).transform(Number),
  file: z.file(),
});

@Controller('/uploads')
class UploadsController {
  @Post({
    response: z.object({ name: z.string(), revision: z.number() }),
    body: {
      multipart: {
        maxFiles: 1,
        maxFileBytes: 25 * 1024 * 1024,
        maxFields: 10,
        maxFieldBytes: 16 * 1024,
      },
    },
  })
  create(@Body(Upload) form: SchemaOutput<typeof Upload>) {
    // A native File, an enum, a uuid and a number; validation ran once.
    return { name: form.file.name, revision: form.revision };
  }
}
```

Form schemas describe flat, named text or binary fields and arrays of those
fields; the application fails to start when a field cannot arrive as text or a
file. Use wire strings plus schema transforms for numbers, booleans, dates, or
other handler values. `z.file()` exports a binary schema; other schema libraries
can use `defineDto` with a directional converter describing each file as
`{ type: 'string', format: 'binary' }` and a parser that validates native `File`
values. Files are not JSON/base64 strings. Nested objects, mixed text/file
unions, and open dictionaries are rejected as ambiguous form contracts.

An array uses repeated exact keys: `tags=one&tags=two`; a single entry still
becomes an array. Keys such as `tags[]` are literal, with no bracket/dot nesting.
Missing fields stay absent. Required arrays need at least one entry on the wire;
an empty client array sends no entries. Make fields optional in the schema, and
make the body schema optional to allow an absent body. When a whole-body schema
describes the form's fields (it converts to JSON Schema), duplicate scalar
fields, unknown names, and the wrong text/file kind return 400. Without one —
`@Body()` without a schema, only named `@Body('field', schema)` parameters, or
a schema without a JSON Schema converter — the route accepts any field and a
repeated name arrives as an array; declare a whole-body schema to enforce the
fields. A malformed multipart
body returns 400; the wrong media type returns 415. URL-encoded text follows
native `URLSearchParams` decoding. Schema errors use the validation error body;
transforms run once, after guards.

Limits have finite defaults. URL-encoded forms: 1 MiB of encoded body bytes,
100 text entries and 64 KiB per text entry including its UTF-8 key. Multipart:
1 file of at most 1 MiB, 100 text entries of at most 64 KiB, and `maxBytes` —
the whole encoded body — `maxFiles × maxFileBytes` plus 1 MiB for text fields
and multipart framing. Repeated entries count individually. Limits must be
positive safe integers; exceeding one returns 413: every entry is measured
before any field is interpreted, so too many fields or files answer 413 before
an unknown field answers 400. The body is read after guards, counting the bytes
actually received and cancelling at `maxBytes`; it is never buffered beyond the
limit. The route's `maxBytes` replaces `security.body.maxBytes` for that route,
so an upload route needs no separate override; `security.body.streamingOverrides`
still take precedence. Parsing buffers a bounded body and creates native files;
streaming storage is a separate concern. A JSON route can bound its body with
`body: { json: { maxBytes: 4096 } }`. OpenAPI exports resolved limits as
`requestBody['x-vela-body-limits']`.

URL-encoded forms carry text fields and text arrays; files require multipart.
The CLI emits `formEncodings` for form routes, alongside the full `AppType`
request and response types:

```ts
import { hc, withFormEncoding } from '@velajs/client/http';
import { formEncodings, type AppType } from './api.generated';

const client = hc<AppType>('https://api.example.com', {
  fetch: withFormEncoding(formEncodings, globalThis.fetch),
});
await client.uploads.$post({
  form: {
    kind: 'avatar', ownerId: userId, revision: '2',
    file: new File(['hello'], 'avatar.png', { type: 'image/png' }),
  },
});
```

Hono always builds `FormData` for `form` inputs. `withFormEncoding` converts it
to `URLSearchParams` only for the declared URL-encoded routes, preserving repeated
keys. Multipart calls use native fetch boundaries; omit `Content-Type` when
sending files. The adapter rejects conflicting media headers and URL-encoded
files. Generated file inputs accept `File | Blob` (including arrays); a Blob
uses the native default filename, so use a File when its name matters. Generated
URL-encoded calls require the adapter; using bare `hc` sends multipart and the
server rejects it with 415.

Overlapping route templates with different form media types are rejected by the
adapter when their resolved paths collide. Use disjoint paths or an explicit
transport for those routes.

Pass a browser/native fetch implementation as the second argument, binding its
receiver if needed. Signals, credentials, shared headers, and other request
options pass through. If a call overrides `fetch`, wrap that override too.
Native callers can also send their own `FormData` or `URLSearchParams` directly
with fetch. This entrypoint has no Expo dependency.

## Binary, streaming and native responses

Use a native response format when the handler returns bytes or owns the Fetch
response. These formats take no `response` schema; they check the native object
without parsing its body:

```ts
@Controller('/files')
class FilesController {
  constructor(
    private readonly files: FileStore,
    private readonly feed: EventFeed,
  ) {}

  @Get('/:id', { format: 'binary', contentType: 'application/pdf' })
  download(@Param('id') id: string) {
    return this.files.read(id); // Blob, ArrayBuffer or Uint8Array
  }

  @Get('/events', { format: 'stream', contentType: 'text/event-stream' })
  events() {
    return this.feed.stream(); // ReadableStream<Uint8Array>
  }

  @Get('/proxy', { format: 'response' })
  proxy() {
    return fetch('https://upstream.example/report'); // Response
  }
}
```

`binary` accepts `Blob`, `ArrayBuffer`, `Uint8Array` backed by an `ArrayBuffer`,
or `Response`. `stream` accepts an unlocked `ReadableStream<Uint8Array>` or
`Response`. `response` requires a `Response`. The decorator enforces these return
types; other values fail through the server-error pipeline. Stream producers are
responsible for emitting byte chunks; Vela does not inspect or validate
individual chunks or event records.

For a bare body, Vela applies the route status and `contentType` (default
`application/octet-stream`). The media type must be concrete and have no
parameters. A native `Response` keeps its own status, status text, headers and
body; metadata does not override it. Set charset, multipart boundary, download
filename, cache headers and range headers on the returned `Response` when needed.
Document each other status with `@ApiResponse`; the route's status describes its
primary response. For example, `@ApiResponse({ status: 206, description: 'Partial
content', format: 'binary', contentType: 'application/pdf' })` describes an
additional native response without a JSON schema. JSON error schemas can be
declared on the same method.

The mapper does not read, clone, tee, or buffer streaming bodies. The existing
request-scope tracker forwards demand and cancellation with bounded prefetch;
resources remain alive until the body finishes, fails, or cancellation settles.
A producer error after headers is a rejected body read, not a replacement JSON
500 response. Input validation and errors before headers retain the normal HTTP
error handling.

OpenAPI uses the declared media type and `x-vela-response-format` (`binary`,
`stream`, or `response`). Binary/stream bodies use a binary string schema; it
describes wire bytes, not an arbitrary JSON record. The CLI also recognizes
binary media/schema declarations and event-stream/NDJSON media types in imported
documents. Multiple response media types produce an unknown native response
contract, so content negotiation cannot silently select a JSON schema.

```ts
import { hc, readHttpResponse } from '@velajs/client/http';
import type { AppType } from './api.generated';

const client = hc<AppType>('https://api.example.com');
const response = await readHttpResponse(client.download.$get(), 'response');
// Same native response; status and headers are available before consumption.
if (response.ok) {
  const file = await readHttpResponse(response, 'blob');
  // blob() buffers the body, as with native fetch.
}

const streaming = await client.events.$get();
const body = await readHttpResponse(streaming, 'stream');
// No body reads, buffering or automatic status handling.
const reader = body?.getReader();
try {
  const chunk = await reader?.read(); // Uint8Array | undefined
} finally {
  await reader?.cancel('finished');
  reader?.releaseLock();
}
```

Generated native response `.json()` results are `unknown`, even for a native
`application/json` response. Validate decoded data before using domain fields.
`readHttpResponse(..., 'response')` returns `HttpResponse<Status>`, preserving the
status type and keeping JSON results unknown on both the response and its clones.
Blob mode uses native `blob()`; stream mode returns `body`, including `null` for
bodyless responses. These helpers leave unsuccessful HTTP statuses available
without reading error bodies. Check status before consumption and keep JSON
error responses documented for status narrowing. Use native readers or
`readHttpResponse` for streams; Hono's `parseResponse` consumes the body and is
intended for JSON/text calls. There is no automatic SSE or NDJSON record parser.
