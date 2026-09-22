# HTTP client

`HttpModule` provides an injectable `HttpService` backed by the Web Fetch API.
Use the bare module for default settings, or configure defaults with `forRoot()`
or `forRootAsync()`:

```ts
import { HttpModule, HttpService, Injectable, Module } from '@velajs/vela';

@Module({
  imports: [HttpModule.forRoot({
    baseURL: 'https://api.example.com/v1',
    timeout: 5_000,
    maxResponseBytes: 1_048_576,
    headers: { Accept: 'application/json' },
  })],
})
export class ApiModule {}

@Injectable()
export class ItemClient {
  constructor(private readonly http: HttpService) {}

  list(signal?: AbortSignal) {
    return this.http.get('/items', { params: { active: true }, signal });
  }
}
```

The client offers `get`, `post`, `put`, `patch`, `delete`, `head`, and
`request({ method, url, body, ...options })`. Successful calls return
`{ data, status, statusText, headers }`. It makes one transport call per request;
there are no automatic retries. A configured transport may implement its own
policy, and native fetch retains its normal redirect behavior.

## URLs and headers

`baseURL` remains a literal string prefix for compatibility. With
`baseURL: 'https://api.example.com/v1'`, `get('/items')` calls
`https://api.example.com/v1/items`. Slashes are not inserted or removed, and an
absolute request URL does not override the prefix. Omit `baseURL` when supplying
complete URLs.

`params` appends encoded query values after any existing query and before the
fragment. Existing query bytes and fragments are preserved. Duplicate names
append a value rather than replacing the existing value:

```ts
http.get('/items?tag=first#details', { params: { tag: 'second', page: 2 } });
// /items?tag=first&tag=second&page=2#details
```

Headers accept any `HeadersInit`: records, name/value tuples, or `Headers`.
Request headers override module defaults case-insensitively. Each request gets
its own normalized `Headers`; caller-owned and default header objects are not
modified.

## Request bodies

| Body value | Behavior |
| --- | --- |
| String, `Blob`, `ArrayBuffer`, typed array, `DataView`, `URLSearchParams`, `ReadableStream` | Forwarded directly to the transport |
| `FormData` | Forwarded directly; `Content-Type` is removed so fetch generates the multipart boundary |
| Objects, arrays, numbers, booleans, `null` | JSON serialized; `application/json` is added only if no content type exists |
| `undefined` | No body |

Explicit `null` remains JSON `null` for compatibility. Native streams are passed
with `duplex: 'half'` for transports that require it. JSON serialization errors
are raised before transport starts. A pre-serialized JSON string needs an
explicit JSON content type. For binary and URL-encoded bodies, avoid setting a
default JSON content type; normal fetch content-type inference applies when no
header is present. FormData always lets the transport choose its boundary, even
when a content type was supplied in defaults or request options.

## Response decoding and validation

`application/json` and media types ending in `+json` are decoded as JSON; matching
is case-insensitive and ignores media-type parameters. Other bodies are decoded
as UTF-8 text. HEAD, 204, 205, absent bodies, and genuinely empty bodies with
`Content-Length: 0` produce `undefined`. An empty JSON body without one of these
conditions is a JSON syntax error.

Supply `schema` to validate the decoded value and infer the schema's output:

```ts
import { z } from 'zod';

const item = z.object({ id: z.string(), count: z.string().transform(Number) });
const response = await http.get('/items/one', { schema: item });
response.data.count; // number, validated and transformed
```

The shared [validation machinery](types.md) accepts Standard Schema
validators, `defineDto` descriptors, and parsers with `parse`/`parseAsync`.
Async validation is awaited once. Validation failures use
`SchemaValidationError`; validator implementation exceptions retain their
original identity. Bodyless responses still run a supplied schema against
`undefined`.

Existing calls such as `http.get<Item>('/items/one')` remain available. Their
generic type is a compile-time assertion, **not runtime validation**. Without a
schema or a selected/inferred generic output, data is `unknown`. Schema-bearing
calls infer the validator's output and cannot select an unrelated generic result.
For reusable options, `satisfies RequestConfig<typeof item>` preserves the required
`schema` property for overload inference.

## Cancellation, timeouts, and size limits

Per-request `signal` composes with the request or module timeout. The first
cancellation wins. A pre-aborted signal prevents the transport from running;
caller cancellation preserves `signal.reason`, while timeouts produce a
`DOMException` named `TimeoutError`. The deadline covers transport, response
reading, and asynchronous schema validation. Timers and signal listeners are
removed after completion. Cancellation rejects promptly even if a custom
transport or validator ignores it; such code may continue its own work. A late
response is cancelled, and a body reader is cancelled when reading is interrupted.
Synchronous JavaScript, including JSON parsing, cannot be interrupted mid-call.

`timeout` accepts integer milliseconds from 0 through 2,147,483,647. Omit both
module and request settings for no timeout. Request settings override module
defaults.

`maxResponseBytes` accepts a non-negative safe integer. It counts bytes actually
read from successful response streams before decoding, including when
`Content-Length` is absent or incorrect. The chunk that crosses the limit is not
decoded or buffered by the client, and the reader is cancelled. The limit is a
wire-body byte limit, not a total JavaScript heap cap; text and parsed objects
can occupy more memory. `HttpResponseSizeException` exposes `maxResponseBytes`
and `receivedBytes`. A request can override the module limit; omitting both means
unlimited buffering. Zero permits only empty bodies.

Non-2xx responses throw `HttpRequestException` with the original readable
`response`. These error bodies are not buffered by the client and therefore are
not subject to its buffer limit. Once the exception is returned, reading or
cancelling that body is the caller's responsibility. Transport, stream, JSON,
and cancellation errors otherwise retain their original identity.

Invalid limits, signals, schemas, transports, or headers are rejected before I/O.

## Injectable transports

Pass a fetch function or an object with a `fetch` method through module options
or individual request options. Object methods keep their original receiver,
allowing Workers service bindings and similar adapters:

```ts
const http = new HttpService({ transport: env.INTERNAL_API });
await http.get('https://internal.example/items');

await http.get('https://example.com/items', {
  transport: async (url, init) => new Response(JSON.stringify({ url }), {
    headers: { 'Content-Type': 'application/json' },
  }),
});
```

Use a Workers type environment for Workers bindings. Mixing separately imported
Workers Web API declarations with DOM/Node declarations can produce conflicting
`RequestInit` and `Response` types. The transport contract uses the environment's
Web API types and has no Cloudflare runtime dependency.

## Instrumentation interface

`HttpModuleOptions.observer` accepts an optional `HttpClientObserver`.
`onRequest({ method, url, headers })` runs synchronously after request options
have been validated and before transport starts. Its mutable per-request
`Headers` support trace-header propagation. It returns optional per-request
hooks:

- `onResponse({ status, statusText, headers })` observes response headers before
  status checks, buffering, or validation. Headers are copied for observation.
- `onError(error)` receives the original transport, status, decoding, validation,
  limit, or cancellation error.
- `onEnd()` runs exactly once after completion or failure, including body parsing
  and validation. A pre-aborted request also reaches the error and end hooks.

Hooks do not receive request or response body contents. Synchronous hook errors
and rejected promises from completion hooks do not alter request results;
completion hooks are not awaited. The observer implements reporting and trace
policy. The HTTP client does not create a separate telemetry system.
