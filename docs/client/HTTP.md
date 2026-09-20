# Typed HTTP client

`@velajs/client/http` exports Hono's `hc` client and its response helpers. Generate a type-only contract from Vela's OpenAPI metadata, then import it in your frontend. No server modules are included in the browser bundle.

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

Use a schema-bearing endpoint definition for both runtime validation and generated types. The method receives one parsed object with `param`, `query`, `header`, and `json` groups. With Zod 4.4 or later:

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

The generated `AppType` uses Hono's schema types. `Schemas` exports named DTO/component types. Missing schemas become `unknown` with diagnostics on stderr; `--strict` fails instead. Unsupported path syntax, parameter serialization, or media types fail generation. `@Endpoint` supplies runtime validation; documentation-only schemas remain declarations. Imported OpenAPI files are decoded before generation, and malformed nested fields fail with a path diagnostic.

The generator currently supports JSON request bodies, JSON/text responses, component schema references, object properties, arrays, enums, unions/intersections, and nullable values. Use object DTOs for whole-query parameters and whole-body DTOs for request bodies. Use separate input/output definitions for `readOnly` or `writeOnly` fields. Multipart uploads, cookie parameters, external references and custom parameter serialization require a separately authored contract. Paths with a trailing slash (other than `/`) or reserved `hc` segments such as `index` and `then` are rejected; use `@Get()` for a controller's base route. Contributed routes need OpenAPI metadata from their contributor; raw Hono mounts are not inferred.

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
