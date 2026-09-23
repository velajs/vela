# HTTP errors

Every HTTP failure that the framework renders itself uses one JSON body:

```json
{ "error": { "code": "not_found", "message": "Route not found" } }
```

`code` is an error catalog code from `@velajs/errors`, `message` is client-safe
text, and the optional `details` field carries structured data such as
validation issues.

## Failures and their bodies

| Failure | Status | `code` | `message` |
| --- | --- | --- | --- |
| Endpoint input, `ValidationPipe`, or `ZodValidationPipe` validation | 400 | `bad_request` | `Validation failed`, with `details` |
| Malformed JSON or form body | 400 | `bad_request` | Describes the problem |
| `HttpException` with a string message (handlers, guards, pipes, middleware) | Its status | The status's catalog code (`internal` if none) | Its message, with `details` when set |
| `VelaError` | Its status | Its code | Its message, with `details` from `data` |
| Any other error | 500 | `internal` | `Internal Server Error` |
| Endpoint form limit or wrong form media type | 413 or 415 | `payload_too_large` or `unsupported_media_type` | Names the exceeded limit or expected media type |
| Body larger than `security.body.maxBytes` | 413 | `payload_too_large` | `Request body exceeds the configured limit` |
| Query beyond `security.query` limits | 400 | `bad_request` | `Query string exceeds the configured limit` (or the parameter count/depth variant) |
| No route matched | 404 | `not_found` | `Route not found` |

Errors that are neither an `HttpException` nor a branded `VelaError`, and
`VelaError`s with an internal code, are redacted to the catalog title; the
original error only reaches the reporter.

A validation failure lists each issue's message, path (keys and array indices),
and validator code when present. Input values and vendor-specific fields are
omitted:

```json
{
  "error": {
    "code": "bad_request",
    "message": "Validation failed",
    "details": [{ "message": "Too small: expected string to have >=1 characters", "path": ["json", "name"], "code": "too_small" }]
  }
}
```

Responses you author keep their shape. An `HttpException` built with an object,
such as `new ConflictException({ success: false, result: null })`, is sent
verbatim. A Hono `HTTPException` below 500 keeps its own response, and a
`Response` returned by an exception filter or render hook is sent as is.

Attach structured data to your own exceptions with the `details` option:
`new BadRequestException('Invalid range', { details: { field: 'end' } })`.
`getDetails()` returns it and `getResponse()` includes it. The renderer reads
the message and details directly, so overriding `getResponse()` does not change
the body; use a render hook or an object response instead.

## Rendering order

Every HTTP failure renders through the same tail: the application's
`ExceptionHandler.render` hook, then the default body. Before that tail:

- Controller handlers (including guards, pipes, and interceptors) report the
  error through `ExceptionHandler.report`, then try exception filters (handler,
  controller, then global).
- Middleware reports the error, then tries global exception filters.
- Framework request rejections, meaning the body and query limits and unmatched
  routes, are client faults detected before application code runs. They are
  not reported and skip exception filters, so a catch-all filter that returns
  a value cannot turn them into 200 responses.
- Errors that escape those boundaries, such as raw Hono middleware added to
  `app.getHonoApp()`, are reported (except a Hono `HTTPException` below 500, an
  intended client response) and go straight to the render hook.

The default reporter logs only server errors. Routes that adapters or
applications add to the built app (OpenAPI documents, WebSocket upgrades,
mounted handlers) still match before the not-found path.

## Customizing every error in one place

Register an `ExceptionHandler` with `ErrorsModule.forRoot({ handler })` or
`app.useGlobalExceptionHandler(handler)`. Its `render` hook sees every failure
above, including limits and unmatched routes. `toHttpErrorBody(error, { context })`
returns the default result, or `undefined` when the error carries its own
response, so a hook can adapt the default instead of rebuilding it:

```ts
import { ErrorsModule, Module, toHttpErrorBody, type ExecutionContext } from '@velajs/vela';

const messages: Record<string, Record<string, string>> = {
  es: { not_found: 'No encontrado', bad_request: 'Solicitud no válida' },
};

@Module({
  imports: [
    ErrorsModule.forRoot({
      handler: {
        render(error, context) {
          const result = toHttpErrorBody(error, { context });
          if (!result) return undefined; // explicit responses stay unchanged
          const locale = (context as ExecutionContext).getRequest().headers.get('accept-language');
          const message = locale ? messages[locale]?.[result.body.error.code] : undefined;
          if (!message) return result;
          return { ...result, body: { error: { ...result.body.error, message } } };
        },
      },
    }),
  ],
})
class AppModule {}
```

Passing the hook's `context` makes `toHttpErrorBody` use the application's
composed catalog, so codes marked `internal` in your catalogs stay redacted
exactly as in the default body; `{ catalog }` selects one explicitly. A hook can
also return a `Response`, or `undefined` to keep the default.

## The render context

For HTTP, `render(error, context)` always receives an `ExecutionContext` whose
`getType()` is `'http'`, with `getRequest()`, `getContext()`, and
`getContainer()`. For a controller failure, `getClass()` and `getHandler()`
identify the controller and method. For a failure outside a controller,
`getClass()` returns `VelaMiddlewareHost` and `getHandler()` returns:

- `VELA_MIDDLEWARE_HANDLER` (`Symbol.for('vela.middleware')`) for middleware,
  the framework's request limits, and errors that escape other boundaries;
- `VELA_NOT_FOUND_HANDLER` (`Symbol.for('vela.not-found')`) when no route
  matched.

Exception filters for middleware failures receive the same context. An
unmatched route is rendered as `new NotFoundException('Route not found')`, so a
hook can also match it by type. Use the context argument, such as
`context.getContainer()`, rather than ambient accessors: request limits run
before the optional ambient-container middleware.
