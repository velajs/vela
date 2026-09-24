# @velajs/rpc

Schema-inferred method RPC for Vela applications, browsers and Worker service bindings. The portable root entry uses `Request`, `Response`, `fetch` and `AbortSignal`. Import `@velajs/rpc/server` only in the application serving procedures.

```sh
pnpm add @velajs/rpc
# Server applications also need @velajs/vela. Choose your own schema library.
pnpm add @velajs/vela zod
```

## Define a shared contract

Keep contracts in a module that does not import server classes or environment bindings. Vela's shared validation contract accepts Standard Schema and synchronous or asynchronous parser schemas. Standard Schema carries both input and output types; legacy parser-only schemas retain `unknown` input.

```ts
// contracts.ts
import { defineProcedure } from '@velajs/rpc';
import { z } from 'zod';

export const greet = defineProcedure({
  name: 'greetings.hello',
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ message: z.string() }),
  idempotent: true,
});
```

Names have at least two dot-separated identifier segments, such as `users.find`. Each segment starts with a letter and may contain letters, numbers, `_` and `-`; the whole name is limited to 160 characters. Names are unique within an application. Duplicate registrations fail startup, including registrations of the same procedure in two modules.

## Module configuration

Import `RpcModule` from `@velajs/rpc/server` into the root module:

```ts
@Module({
  imports: [RpcModule.forRoot({ path: '/rpc', authorize: 'public' })],
  providers: [Greetings],
})
class AppModule {}
```

`forRootAsync({ imports, inject, useFactory })` resolves server options through DI.
The module uses the same dispatcher and explicit exposure policy as the low-level
adapter below, without applying guards or interceptors twice. Use either the
module or adapter for a given endpoint, not both.

Named clients are registered and exported as ordinary providers:

```ts
RpcClientModule.forRootAsync({
  name: 'catalog',
  binding: 'CATALOG',
  inject: [ENV],
  useFactory: env => ({ url: 'https://catalog/rpc', fetch: env.CATALOG }),
});
// constructor(@Inject(rpcClientToken('catalog')) private catalog: RpcClient) {}
```

`forRoot({ name, ...clientOptions })` accepts synchronous options; `name` and `binding` are structural, so `forRootAsync` takes them next to its factory. `binding` is
optional deployment metadata; when declared, a fetch transport is required and
`vela deploy check` checks that service binding in the selected environment.
The browser entrypoint remains independent of the framework. See the
[four-worker example](../../apps/module-workers/README.md).

## Register an ordinary provider

```ts
import { Injectable, Module, VelaFactory } from '@velajs/vela';
import type { ProcedureInput } from '@velajs/rpc';
import { Rpc, rpcAdapter } from '@velajs/rpc/server';
import { greet } from './contracts';

@Injectable()
class Greetings {
  readonly #prefix = 'Hello';

  @Rpc(greet)
  hello(input: ProcedureInput<typeof greet>) {
    return { message: `${this.#prefix}, ${input.name}!` };
  }
}

@Module({ providers: [Greetings] })
class Application {}

const app = await VelaFactory.create(Application, {
  adapters: [rpcAdapter({ path: '/rpc', authorize: 'public' })],
});

export default { fetch: (request: Request) => app.fetch(request) };
```

The adapter is opt-in and requires an explicit exposure policy. `authorize: 'public'` allows the adapter's own authorization check; application globals and class/method guards still apply. Supply `authorize: async (context) => boolean` to add an application policy. It runs in the global guard phases as the first `authorize` guard: after global authentication (Better Auth, Cloudflare Access) and tenant admission, so it can read the trusted identity with `getTrustedRequestIdentity(context.getRequest())`, and before the other global authorize guards, feature guards and class/method guards. The context is the existing HTTP execution context, extended with `procedure` and `callId`. Its request, trusted identity, owning module and request container come from Vela's HTTP boundary. Identity is never accepted from an RPC envelope.

Only `@Rpc` methods on registered class-token providers are callable. Each application builds its own registry. Module ownership is retained during discovery and async DI resolution. Guards run before input parsing and handler construction. The real provider instance receives the call, preserving private fields. Request-scoped providers, `REQUEST_CONTEXT`, `EXECUTION_LIFETIME` and lazy modules follow the host application's lifetime rules; consume or cancel the HTTP response body to finish its scope.

The adapter registers a full absolute `POST` path, defaulting to `/rpc`. Include an application prefix in that path explicitly. An existing exact `POST`/`ALL` route at that path is rejected. Use Vela middleware for CORS, payload limits and other HTTP policies as appropriate for the application.

## Call through fetch

```ts
import { createRpcClient } from '@velajs/rpc';
import { greet } from './contracts';

const client = createRpcClient({
  url: 'https://api.example.com/rpc',
  headers: () => ({ authorization: `Bearer ${getToken()}` }),
  timeoutMs: 5_000,
});

const result = await client.call(greet, { name: 'Vela' });
console.log(result.message); // inferred string
```

Pass a service binding directly: `createRpcClient({ url: 'https://service/rpc', fetch: env.SERVICE })`. Its `fetch` receiver is retained. A custom `(request: Request) => Promise<Response>` works too. The URL must include the complete endpoint path. Use `credentials: 'include'` when browser cookie authentication requires it. Per-call `headers` override configured headers; the client supplies JSON content and accept headers.

`examples/worker.ts` is a runnable Worker with the shared contract in `examples/contracts.ts`. `pnpm --filter @velajs/rpc test:workers` runs it through an actual workerd Fetcher without `nodejs_compat`.

## Transform once at each server boundary

| Type | Meaning |
| --- | --- |
| `ProcedureWireInput<P>` | Original input sent by the client |
| `ProcedureInput<P>` | Parsed input received by the handler |
| `ProcedureResult<P>` | Handler result before output parsing |
| `ProcedureOutput<P>` | Parsed output returned to the client |

For an input schema transforming a string into a number, the client sends the string and the method receives the number. For an output schema transforming a number into an object, the method returns the number and the client receives the object. Async parsing is awaited. The client never repeats a server schema transform. The method decorator checks the handler's input and return types at compile time.

Global and scoped pipes run before the input schema, using `type: 'custom'` metadata and their `transformAsync` hook when available. Interceptors wrap invocation. Output validation covers the final result, including interceptor replacements or short circuits. Invalid input becomes a correlated 400 failure; invalid output and unexpected exceptions become redacted 500 failures.

The client validates protocol identity, outcome, error fields and JSON structure. Its default domain result type relies on a matching, trusted server contract. When calling a custom or independently deployed peer, supply an independent decoder for the **wire result**:

```ts
const result = await client.call(greet, { name: 'Vela' }, {
  decode: (value) => z.object({ message: z.string() }).parse(value),
});
```

Do not reuse a transforming server output schema for this decoder: its input describes the handler result before projection. Share a separate schema for the projected wire shape when independent client validation is needed.

## Failures, deadlines and retries

`RpcError` carries a correlated application error's `code`, `status`, `procedure` and `id`. `RpcHttpError` carries an unframed HTTP failure's `status`. `RpcProtocolError` identifies an invalid envelope. Caller abort reasons and network failures are preserved; deadlines reject with `TimeoutError`. Response size failures use `RangeError`, and invalid JSON uses `SyntaxError`.

The default deadline is 30 seconds and the default response limit is 1 MiB (`maxResponseBytes`). One deadline covers configured header resolution, fetch, response reading, retry delays and an optional decoder. Override it with per-call `timeoutMs`, and pass a `signal` for cancellation. Cancelling cannot roll back a completed side effect or forcibly interrupt server work; handlers can observe the shared execution lifetime's signal for cooperative cancellation.

Calls make one attempt by default. Explicit retries require both `idempotent: true` in the contract and per-call `retry: { maxAttempts: 2, delayMs: 100 }`. At most five attempts are allowed. Only transport failures and unframed gateway 502/503/504 responses are eligible. Framed application failures, validation failures and decoder failures are final. A correlation ID is retained across retries; it is **not** an idempotency key and the server does not deduplicate requests.

The server uses Vela's existing exception reporter, error catalog and exception filters, and derives each failure from Vela's shared `renderHttpError`. A terminal filter/renderer response remains an RPC failure; its error status is retained, while arbitrary HTTP bodies are replaced by the RPC envelope. As over HTTP, a filter's `{ status, body }` sets the status, any other value keeps the exception's status, and `undefined` leaves the error to the renderer. An attempted success status from an error filter becomes 500. An exception-owned `toResponse()` contributes its status, plus its body's `error.code` and `error.message` when the body has that member (such as the CRUD envelope); any other owned field is dropped, and a 5xx owned body is redacted. A malformed code becomes the status's code, and a failure coded `internal` always carries the generic message. Unknown internal errors are redacted and reported once. Only the safe code, message and status are sent; stacks, request inputs and internal error details are excluded.

## Wire format and scope

V1 uses JSON over HTTP or service-binding `fetch`:

```json
{"version":1,"id":"call-id","procedure":"greetings.hello","input":{"name":"Vela"}}
{"version":1,"id":"call-id","procedure":"greetings.hello","ok":true,"result":{"message":"Hello, Vela!"}}
{"version":1,"id":"call-id","procedure":"greetings.hello","ok":false,"error":{"code":"forbidden","message":"Forbidden","status":403}}
```

Success uses HTTP 200. Failure HTTP status must match its envelope. Extra envelope fields are rejected; malformed requests without a trustworthy correlation identity receive an ordinary HTTP 400. JSON values must be finite and lossless: no `undefined`, `bigint`, cycles, sparse arrays, accessors, custom prototypes or serialization hooks. The structural limit is 64 levels and 100,000 values. Represent dates and other richer values explicitly in schemas.

This package provides single-call method RPC. Native Cloudflare method RPC, WebSocket transport, batching and streaming procedure results require separate adapters and are outside this API. The browser root imports no Vela runtime, Node built-ins or Worker-specific globals. Its emitted structural schema declarations also work without installing Vela.

## Verification

```sh
pnpm --filter @velajs/rpc test
pnpm --filter @velajs/rpc typecheck
pnpm --filter @velajs/rpc test:workers
pnpm --filter @velajs/rpc test:consumer
```

The consumer check copies the built package into an isolated temporary installation with no framework or schema dependencies, typechecks inferred contracts under DOM types, executes a call, and builds a browser bundle.
