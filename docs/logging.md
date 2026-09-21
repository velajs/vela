# Application-owned logging

`Logger` and its text `Writer` remain supported with their existing static settings.
For application-isolated structured logs, import `LoggingModule` once at the root:

```ts
import { APP_LOGGER, Inject, Injectable, LoggingModule, Module } from '@velajs/vela';
import type { ApplicationLogger, LogRecord } from '@velajs/vela';

const records: LogRecord[] = [];
@Module({
  imports: [LoggingModule.forRoot({
    directive: 'warn,orders=debug',
    redactKeys: ['paymentReference'],
    sinks: [(record) => { records.push(record); }],
  })],
})
class AppModule {}

@Injectable()
class Orders {
  constructor(@Inject(APP_LOGGER) private readonly logging: ApplicationLogger) {}

  save(id: string) {
    const log = this.logging.createLogger('orders', { orderId: id });
    log.debug('saving order');
  }
}
```

The provider is global **within that application** by default. It never changes
legacy `Logger` settings or another application's logger. `forRootAsync` accepts
the existing typed provider factory options for environment-owned sinks. Direct
`new ApplicationLogger(options)` also works without modules or DI. No Node APIs,
ambient context, console patching, or telemetry service is required.

`createLogger(category, fields)` snapshots fields; `withFields(fields)` and
`extend(namespace)` create independent children. Passing request fields to a child
keeps singleton services reusable. Avoid mutating shared state for each request.

## Records and subscriptions

Every sink receives the same deeply frozen JSON-safe `LogRecord` with `timestamp`
(milliseconds), `level`, `category`, `message`, `fields`, and `arguments`. The levels
retain Vela's `LOG`, `ERROR`, `WARN`, `DEBUG`, and `VERBOSE` names. A nonstring first
argument (including Error) is retained in `arguments[0]`; the textual message is
also derived from its normalized representation.

`subscribe(sink)` returns an idempotent unsubscribe function. Function identity
deduplicates configured sinks and subscribers. An empty `sinks: []` disables the
default JSON console sink while allowing subscribers. Optional integrations such
as Studio can subscribe and detach with their own lifecycle; legacy global
Logger calls and arbitrary console calls are not captured.

## Serialization and redaction

All fields and arguments are normalized before reaching **any** sink. Defaults:
6 levels, 32 entries per collection, 512 visited nodes per serialized value and
2048 code units per string. Options `maxDepth`, `maxEntries`, `maxNodes`, and
`maxStringLength` have validated finite bounds. Cycles, truncation, nonfinite
numbers, BigInts, undefined, functions, and inaccessible values have explicit
string markers. The serializer reads own data properties and never invokes
`toJSON`, `toString`, or accessors. Error name/message/stack/cause receive explicit
handling; stacks implemented as runtime accessor properties become `[Accessor]`.
Other object types expose only their own enumerable data properties. Use plain
records for deliberate projections; `serializeLogValue` exposes the same policy.

Authorization headers, cookies, passwords, common token/API-key fields and
credentials are redacted by case-insensitive key at every depth. `redactKeys`
adds application keys. An own data marker `[Symbol.for('vela.secret')] === true`
redacts the entire value without executing a method. This supports secret wrappers
with real `#private` storage. Key redaction cannot discover secrets embedded in
free-text messages or stack strings; avoid putting credentials in those strings.

## Levels and delivery

`directive` accepts comma-separated levels and exact categories, for example
`warn,http=debug`. `info` aliases `log`; `off` aliases `silent`. Explicit category
settings override the default. `configure(directive)` validates all entries before
applying any change; `isEnabled(LogLevel.DEBUG)` guards expensive message creation.
There is no implicit read of environment variables or wildcard category expansion.

Synchronous and asynchronous sink failures are contained and counted in
`diagnostics.failed`; recursive synchronous logging is dropped. `maxPending`
(default 1024) bounds unfinished async deliveries; when full, new sink deliveries
are dropped and counted in `diagnostics.dropped`. No retries or storage guarantees
are added. `flush()` awaits deliveries pending at its call. Application teardown
stops logging and drains those deliveries; sinks must settle their promises.

An explicit third `createLogger` argument `{ fields, waitUntil }` binds protected
invocation metadata and a completion callback. These fields override ordinary
child fields; asynchronous deliveries are passed to `waitUntil`. Adapters can
supply a managed invocation lifetime without introducing global request state.

## Invocation correlation and exceptions

Use `loggerForScope` with the existing invocation child to attach the generated
`invocationId` and, for HTTP, the current `REQUEST_CONTEXT.id` as `requestId`:

```ts
import { loggerForScope, runInEntrypointScope } from '@velajs/vela';

await runInEntrypointScope(app.getContainer(), async (scope) => {
  loggerForScope(scope, 'orders', { source: 'Orders.process' }).log('processing');
});
```

A controller interceptor or custom transport can pass `executionContext.getContainer()`
when it exists. Do not pass the application root and expect request context to
appear. The helper uses the shared execution lifetime and existing HTTP context;
it does not parse headers, create a second invocation, or infer tenant identity.
Request ID acceptance remains the HTTP context's compatibility policy. These IDs
are correlation metadata, never authentication claims. Optional tenant/trace
fields require deliberate projection by their owning adapters.

The scope helper protects correlation fields from `withFields` overrides, tracks
async sink delivery through `ExecutionLifetime.waitUntil`, and stops retained
loggers once the invocation closes. Creating another scoped logger from a closed
managed container throws. Outside managed scopes, explicitly call `flush()` or
supply a completion callback; an application logger alone cannot prolong a
platform invocation. Optional `isActive` on the explicit delivery context allows
custom adapters to enforce their own ownership lifetime.

`resolveErrorReporter` sends default server-error reports to `APP_LOGGER` when
installed, including source/edge and correlation fields. It preserves default
4xx and `diagnostics: 'silent'` suppression. No raw console fallback bypasses
redaction when a sink fails. Without `LoggingModule`, existing console reporting
continues unchanged.

A custom `ExceptionHandler.report` remains a replacement: it receives the original
error once and no default structured record is also sent. `dontReport` still
suppresses delivery; context hooks may enrich metadata but cannot overwrite the
scope helper's correlation. Custom asynchronous reporting is retained by managed
invocation completion; its failures remain contained. Rendering/client error
redaction is unchanged. Transport adapters must call the reporter once at their
error boundary; this does not install new global error listeners.

A reporter captured before `scope.finish()` keeps inert correlation metadata for
completion failures. It can report them after child disposal without resolving
request-owned services again. Such late asynchronous deliveries are owned by the
application logger; adapters must explicitly flush/register that work with their
platform lifetime when required. This exception-report path does not reactivate
ordinary retained scoped loggers.
