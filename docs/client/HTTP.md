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

Use a schema-bearing endpoint definition for both runtime validation and generated types. The method receives one parsed object with `param`, `query`, `header`, and either `json` or `form` groups. With Zod 4.4 or later:

```ts
import { Controller, Endpoint, Post, defineEndpoint } from '@velajs/vela';
import { z } from 'zod';

const createUser = defineEndpoint({
  input: z.object({ json: z.object({ name: z.string() }) }),
  output: z.object({ id: z.string(), name: z.string() }),
  status: 201,
});

@Controller('/users')
export class UsersController {
  @Post()
  @Endpoint(createUser)
  create(input: ReturnType<typeof createUser.input.parse>) {
    return { id: crypto.randomUUID(), name: input.json.name };
  }
}
```

`@Endpoint` constrains the method's argument and return types. The dispatcher parses input after guards and validates the final result after interceptors. Invalid input returns 400; an invalid result returns 500. JSON is the default response format, including strings and `null`. A string output can select `format: 'text'`. The endpoint owns its status and parameter parsing, so it cannot be combined with parameter decorators, `@HttpCode`, or `@Redirect` on the same method.

Ordinary parameter decorators can use named descriptors: `const BodyDto = defineDto(schema, { name: 'CreateUser' })`, then `@Body(new ValidationPipe(BodyDto)) body: ReturnType<typeof BodyDto.parse>`. OpenAPI reads that same parser metadata. `@ApiResponse` accepts a descriptor, an exportable schema, or a checked raw JSON Schema; it documents a response without validating the handler's output. Erased TypeScript interfaces cannot supply schemas.

The generated `AppType` uses Hono's schema types. `Schemas` exports named DTO/component types. Missing schemas become `unknown` with diagnostics on stderr; `--strict` fails instead. Unsupported path syntax and parameter serialization fail generation. Native response media types retain an unknown JSON boundary. `@Endpoint` supplies runtime validation; documentation-only schemas remain declarations. Imported OpenAPI files are decoded before generation, and malformed nested fields fail with a path diagnostic.

The generator supports JSON, multipart, and URL-encoded request bodies, JSON/text and native binary/stream responses, component schema references, object properties, arrays, enums, unions/intersections, and nullable JSON values. Form fields have the concrete wire shapes described below. Use separate input/output definitions for `readOnly` or `writeOnly` fields. Cookie parameters, external references and custom parameter serialization require a separately authored contract. Paths with a trailing slash (other than `/`) or reserved `hc` segments such as `index` and `then` are rejected; use `@Get()` for a controller's base route. GET/HEAD request bodies are rejected because `hc` does not send them. Contributed routes need OpenAPI metadata from their contributor; raw Hono mounts are not inferred.

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

Use `input.form` and an explicit `body.contentType`. The same schema supplies the
handler's parsed types and OpenAPI's wire types:

```ts
const upload = defineEndpoint({
  input: z.object({
    form: z.object({
      title: z.string().min(1),
      tags: z.array(z.string()),
      revision: z.string().regex(/^\d+$/).transform(Number),
      file: z.file(),
      attachments: z.array(z.file()).optional(),
      note: z.string().optional(),
    }),
  }),
  output: z.object({ name: z.string(), revision: z.number() }),
  body: {
    contentType: 'multipart/form-data',
    maxBytes: 1024 * 1024,
    maxFields: 20,
    maxFieldBytes: 16 * 1024,
    maxFiles: 4,
    maxFileBytes: 256 * 1024,
  },
});

@Controller('/uploads')
class UploadsController {
  @Post()
  @Endpoint(upload)
  create(input: z.output<typeof upload.input>) {
    // A native File and a number; validation/transformation ran once.
    return { name: input.form.file.name, revision: input.form.revision };
  }
}
```

Form schemas describe flat, named text or binary fields and arrays of those
fields. Use wire strings plus schema transforms for numbers, booleans, dates,
or other handler values. `z.file()` exports a binary schema; other schema
libraries can use `defineDto` with a directional converter describing each file
as `{ type: 'string', format: 'binary' }` and a parser that validates native
`File` values. Files are not JSON/base64 strings. Nested objects, mixed text/file
unions, and open dictionaries are rejected as ambiguous form contracts.

An array uses repeated exact keys: `tags=one&tags=two`; a single entry still
becomes an array. Keys such as `tags[]` are literal, with no bracket/dot nesting.
Missing fields stay absent. Required arrays need at least one entry on the wire;
an empty client array sends no entries. Make fields optional in the schema, and
make the `form` group optional to allow an absent body. Duplicate scalar fields,
unknown names, and the wrong text/file kind return 400. A malformed multipart
body returns 400; the wrong media type returns 415. URL-encoded text follows
native `URLSearchParams` decoding. Schema errors use the existing endpoint error
envelope; transforms run once, after guards.

All forms have finite defaults: 1 MiB of encoded body bytes (including multipart
overhead), 100 text entries, 64 KiB per text entry including its UTF-8 key, 10
files, and 1 MiB per file. Repeated entries count individually. Limits must be
positive safe integers; exceeding one returns 413. The body-byte bound is checked
before native parsing; part limits are checked before schema validation. These
limits supplement `security.body.maxBytes` and its route overrides. Configure
both when accepting larger uploads. Parsing buffers a bounded body and creates
native files; streaming storage is a separate concern. JSON endpoints retain
their existing behavior and can add `body: { contentType: 'application/json',
maxBytes: 4096 }` for a tighter endpoint limit. OpenAPI exports resolved limits
as `requestBody['x-vela-body-limits']`.

For URL-encoded forms, use `body: { contentType:
'application/x-www-form-urlencoded' }` with text fields and text arrays. Files
require multipart. The CLI emits `formEncodings` for form routes, alongside the
full `AppType` request and response types:

```ts
import { hc, withFormEncoding } from '@velajs/client/http';
import { formEncodings, type AppType } from './api.generated';

const client = hc<AppType>('https://api.example.com', {
  fetch: withFormEncoding(formEncodings, globalThis.fetch),
});
await client.uploads.$post({
  form: {
    title: 'Document', tags: ['public'], revision: '2',
    file: new File(['hello'], 'document.txt', { type: 'text/plain' }),
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
response. Omit `output`; these formats check the native object without parsing
its body:

```ts
const download = defineEndpoint({
  input: z.object({ param: z.object({ id: z.string() }) }),
  format: 'binary',
  contentType: 'application/pdf',
});
const events = defineEndpoint({
  input: z.object({}),
  format: 'stream',
  contentType: 'text/event-stream',
});
const proxyResponse = defineEndpoint({
  input: z.object({}),
  format: 'response',
  contentType: 'application/octet-stream',
});
```

`binary` accepts `Blob`, `ArrayBuffer`, `Uint8Array` backed by an `ArrayBuffer`,
or `Response`. `stream` accepts `ReadableStream<Uint8Array>` or `Response`.
`response` requires a `Response`. The decorator and `.bind()` enforce these
return types. Invalid objects, locked streams, and locked or consumed response
bodies fail before handoff through the existing server-error pipeline. Stream
producers are responsible for emitting byte chunks; Vela does not inspect or
validate individual chunks or event records.

For a bare body, Vela applies `status` (default 200) and `contentType` (default
`application/octet-stream`). The media type must be concrete and have no
parameters. A native `Response` keeps its own status, status text, headers and
body; metadata does not override it. Set charset, multipart boundary, download
filename, cache headers and range headers on the returned `Response` when needed.
Document each possible status with `@ApiResponse`; the endpoint's status describes
its primary response. For example, `@ApiResponse(206, { description: 'Partial
content', format: 'binary', contentType: 'application/pdf' })` describes an
additional native response without a JSON schema. Existing JSON error schemas
can be declared on the same method.

The mapper does not read, clone, tee, or buffer streaming bodies. The existing
request-scope tracker forwards demand and cancellation with bounded prefetch;
resources remain alive until the body finishes, fails, or cancellation settles.
A producer error after headers is a rejected body read, not a replacement JSON
500 response. Input validation and errors before headers retain the normal HTTP
error handling. JSON/text endpoint validation and form request parsing retain
their existing behavior.

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
