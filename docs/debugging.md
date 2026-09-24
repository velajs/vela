# Debugging Vela applications

Use Studio for application snapshots and structured logs, and the runtime inspector
for breakpoints. Both work with the ordinary Vela module and handler APIs.

## Local Worker breakpoints

Debug a Vela Worker under `vite dev`, the `dev` script of the CLI Worker
template. `@cloudflare/vite-plugin` serves `src/worker.ts` from source with
source maps and the decorator metadata constructor injection reads, starts the
Worker inspector on the first free port from 9229 (the plugin's `inspectorPort`
option fixes it), and serves a `/__debug` page that opens DevTools for the
Worker. Attach to that port with the configuration below, set a breakpoint
inside a controller method and send an HTTP request to that route:

```sh
pnpm exec vite dev
```

Use `wrangler dev --inspector-port 9229` only on a build that already contains
decorator metadata: run `vite build` first and start Wrangler from the package
directory without `--config`, so it follows the `.wrangler/deploy/config.json`
redirect to the built Worker, or point `main` at a Worker you compile ahead of
time with decorator metadata:

```sh
pnpm exec vite build && pnpm exec wrangler dev --inspector-port 9229
```

Do not run `wrangler dev` on the TypeScript sources: Wrangler bundles them with
esbuild, which emits no `design:paramtypes` metadata, so constructor injection
fails with `MissingInjectionMetadataError`.

Add this configuration to the application's `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Vela Worker",
      "type": "node",
      "request": "attach",
      "port": 9229,
      "cwd": "/",
      "resolveSourceMapLocations": null,
      "attachExistingChildren": false,
      "autoAttachChildProcesses": false,
      "sourceMaps": true
    }
  ]
}
```

Start **Vela Worker** in Run and Debug, then request the route. Use a different
inspector port for a second development process. These attachment settings follow
[Cloudflare's breakpoint guide](https://developers.cloudflare.com/workers/observability/dev-tools/breakpoints/).

If a TypeScript breakpoint stays unbound, check that the running code has source
maps. Under `vite dev` they come from Vite; for a Worker built ahead of time,
check that Wrangler runs a build with source maps, and rebuild before
attaching. Keep the legacy decorator and decorator metadata settings (the
template's `oxc.config.ts`) and class names when customizing compilation; see
[tooling](tooling.md#build-pipeline). Source maps must survive every transform,
including your own bundling steps. A breakpoint in an imported file cannot bind until that module
has loaded; exercise a lazy module's entrypoint first.

## Debug one test

For a normal Node Vitest suite in this workspace:

```sh
pnpm --filter @velajs/studio exec vitest run __tests__/logging.test.ts --inspect-brk --no-file-parallelism
```

Attach a Node debugger to port 9229 and resume the initial pause. Selecting one
file and disabling file parallelism keeps the inspector attached to one test
worker. See [Vitest's debugging guide](https://vitest.dev/guide/debugging).

For the core suite running **inside workerd**, use its Workers configuration:

```sh
pnpm --filter @velajs/vela exec vitest run --config vitest.config.workers.ts src/__tests__/workers/basic.test.ts --inspect --no-file-parallelism
```

Attach to the Workers inspector using the Worker attachment configuration above.
The Node test runner and the Worker are separate debugging targets. See
[Cloudflare's Vitest debugging guide](https://developers.cloudflare.com/workers/testing/vitest-integration/debugging/).

## Capture structured logs in Studio

Configure one logging module and one Studio module per application, then pass those
same configured instances into the optional capture module:

```ts
import { Module } from '@velajs/vela';
import { LoggingModule } from '@velajs/vela/logging';
import { StudioModule } from '@velajs/studio';
import { StudioLoggingModule } from '@velajs/studio/logging';

const logging = LoggingModule.forRoot({ directive: 'debug' });
const studio = StudioModule.forRoot({ logBufferSize: 1000 });

@Module({
  imports: [
    logging,
    studio,
    StudioLoggingModule.forRoot({ imports: [logging, studio], timings: true }),
  ],
})
export class AppModule {}
```

Provide `VELA_STUDIO_TOKEN` through the application's environment configuration;
Studio stays closed without a token. Use the [Studio local host](studio/README.md)
to view the logs. Capture subscribes to `APP_LOGGER`; write through its
`createLogger(category, fields)` API or the scoped logger described in
[Logging](logging.md). Records reach Studio after normalization and redaction.
Legacy `Logger`, `console.log`, and platform logs are separate sources. Capture
unsubscribes when the application closes. Set `sinks: []` on `LoggingModule` if you
want subscription-only delivery.

The buffer is application-owned and bounded. It evicts the oldest entries, copies
returned data, and limits diagnostic fields. Capacity zero disables retention.
It is an in-memory view for the current application instance, not a durable or
fleet-wide log store. `logs.tail` remains behind Studio authentication. Its level
filter works over records that already passed the logger's level configuration.

`timings` defaults to false. When enabled, the interceptor measures `next.handle()`:
handler execution plus inner interceptors. It excludes guards, argument validation,
response-body streaming, and deferred work. A returned `Response` marks handler
completion before its body finishes. `outcome: 'threw'` means an exception left that
boundary; an outer filter may still turn it into a response. Only transports that
run Vela interceptors contribute these rows. Invocation IDs are present when the
execution context has a managed lifetime; they are correlation labels, not identity
or authorization. Error payloads are reported separately by the transport reporter.

## Trace an error response

Every HTTP failure is reported once, then rendered by `renderHttpError` (see
[security](security.md#error-responses)). A 5xx body carries only the status
title, so read the original error where it was reported: the default reporter
logs 5xx and unbranded errors with the failing `Controller.handler` (client 4xx
faults are not logged), and a custom `ExceptionHandler.report` or Studio's log
capture receives every error with its `edge` and `source`. Unmatched routes and
request limits (a JSON 404, 413 and query-limit 400s) are not reported.

The response a client saw comes from the first of these that applies:

1. the application's `ExceptionHandler.render` hook;
2. the first matching exception filter: a `Response`, an explicit
   `{ status, body }`, or any other value sent with the exception's status;
   a filter returning `undefined` falls through;
3. the exception's own `toResponse()`;
4. the canonical `{ error: { code, message, details? } }` body.

Reproduce a body without a request with `renderHttpError(error)`, which returns
`{ status, body, redacted }`; `redacted: true` means the client never saw the
error's own text. `getErrorStatus(error)` returns the status a filter result would
take. In guards and interceptors, `context.getHandler()` is the handler method and
`context.getHandlerName()` its name, which Studio uses to label invocations.

## Inspect ownership and dependency scope

Wire `studioRuntimeAdapter` into `VelaFactory.create(AppModule, { adapters: [...] })`
to attribute controller routes to their handler and module. Contributor-mounted
routes retain the `(mounted)` label when no controller descriptor exists.

Studio's Modules panel shows the public import/export graph and effective scopes
for class-token registrations. Request scope can propagate from a dependency to
its consumer. Entrypoints show their exact owner and scope when supplied by the
registry. These are metadata snapshots: inspection does not construct providers,
activate lazy modules, or inspect private fields. Entrypoint metadata uses bounded
JSON summaries, with markers for cycles, accessors, class instances, and truncation.

For a missing dependency, compare the consumer's owner with the module exporting
the token. Import that module or export its public token. Use a runtime class import
for constructor injection, or explicit `@Inject(TOKEN)` for interfaces and symbols;
`import type` cannot provide a runtime token. See [Modules](modules.md) and
[Runtime values and types](types.md).
