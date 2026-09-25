# Observability

`@velajs/vela/observability` provides optional tracing, metrics, and explicit trace
propagation using Web APIs. Importing it does not start exporters, schedule timers,
send network requests, or install ambient context. Applications own the recorder
and its delivery lifecycle. Without a recorder, all operations are no-ops.

## Record HTTP requests

```ts
import { VelaFactory } from '@velajs/vela';
import { observabilityAdapter } from '@velajs/vela/observability';

const app = await VelaFactory.create(AppModule, {
  adapters: [observabilityAdapter({ telemetry })],
});
```

Install the adapter once per application. `telemetry` implements the small
`Telemetry` interface: `startSpan`, `createCounter`, and `createHistogram`. Spans
provide `context`, `setAttributes`, and `end`; counters provide `add`, and histograms
provide `record`. Recording is synchronous. Exporter flushing and network delivery
belong to the application or its SDK, not the request completion hooks. Recorder
failures are contained and do not replace responses or application errors.

One server span, one `http.server.request.count` increment, and one
`http.server.request.duration` measurement in seconds are recorded per completed
request. Completion reuses the HTTP execution lifetime: it waits for the response
body, managed deferred work, and request resource disposal. It covers early input
rejection, middleware, controller and adapter routes, unmatched routes, streaming
errors, and cancellation. A body intentionally suppressed for HEAD is successful;
a consumer cancellation is `cancelled`. A 5xx response, stream failure, or failed
deferred work/disposal is `error`. Ordinary 4xx responses are successful HTTP
completions. Native upgrades complete at the handshake, not socket closure.

Cancellation is cooperative: an aborted request does not dispose resources still
in use. A stream must finish or be cancelled by its consumer to complete; request
duration is not a response-header latency measurement. Deferred failures remain
observable through native `waitUntil` where available.

Default attributes are limited to normalized `http.request.method`, the registered
`http.route` pattern when available, `http.response.status_code`, and
`vela.outcome` (`success`, `error`, or `cancelled`). Unknown methods use `_OTHER`.
Early rejection or an unmatched route may have no route pattern. A finalization
failure before a bodyless response reaches the transport omits status because
the outer error handler has not yet selected the final response. Span names use
`HTTP <method>`. Concrete URL paths, queries, bodies, headers, error messages,
credentials, request IDs, user IDs, and tenant IDs are never default attributes.

## Explicit context and propagation

Inside an active request, inject `REQUEST_TELEMETRY` or read the scope explicitly:

```ts
import { Inject, REQUEST_CONTEXT, type RequestContext } from '@velajs/vela';
import {
  getRequestTelemetry,
  injectTraceContext,
} from '@velajs/vela/observability';

class RemoteService {
  constructor(@Inject(REQUEST_CONTEXT) private readonly request: RequestContext) {}

  async read() {
    const current = getRequestTelemetry(this.request);
    const span = current.telemetry.startSpan('catalog.read', {
      kind: 'client',
      parent: current.span.context,
    });
    const headers = new Headers();
    injectTraceContext(headers, span.context);
    try {
      const response = await fetch('https://catalog.example/items', { headers });
      const result = await response.json();
      span.end(response.ok ? 'success' : 'error');
      return result;
    } catch (error) {
      span.end(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error');
      throw error;
    }
  }
}
```

`telemetryForScope(container)` is the equivalent explicit container lookup.
Lookups outside an active instrumented invocation return `noopScopedTelemetry`.
No request data is stored in an ambient process context. Passing a span context is
an explicit correlation choice and never grants authentication or tenant access.

Incoming parents are ignored by default. Set `trustIncomingTraceContext: true`
only where your ingress is allowed to join caller-supplied traces. Sampling and
rate limits remain the application's SDK policy. `extractTraceContext(headers)`
validates W3C trace IDs, span IDs, versions, and flags; invalid parents are ignored.
Vendor state is bounded to 512 characters and 32 unique members; invalid state is
dropped while a valid parent is retained. No baggage is extracted. The rules follow
the [W3C Trace Context specification](https://www.w3.org/TR/trace-context/).

`injectTraceContext(headers, context)` writes version 00 trace headers on mutable,
caller-owned `Headers`. It replaces stale `traceparent`/`tracestate`, clears them
for absent or invalid context, and leaves other headers untouched. Only propagate
to intended destinations; choose a new trace or omit propagation at trust
boundaries. Never construct an outbound context from a request ID or tenant ID.

`createHttpClientTelemetryObserver({ telemetry, parent })` provides structural
`onRequest({ method, headers })` hooks for HTTP clients. Each call starts a client
span and returns `onResponse({ status })`, `onError(error)`, and `onEnd()` callbacks.
If the recorder supplies no valid span context, existing caller trace headers are
preserved. Standard method casing follows native Fetch normalization before the
bounded method label is selected; custom methods retain the `_OTHER` fallback.
The caller must invoke `onEnd` once after its chosen transport boundary, including
errors and cancellation; repeated calls are harmless. The mutable headers must be
the headers actually sent by the client. HTTP client status codes from 400 upward
and transport failures use `error`; `AbortError` uses `cancelled`. Client metrics
are `http.client.request.count` and `http.client.request.duration` (seconds), with
method, status when available, and outcome only. No URL or host label is recorded.

## Native Cloudflare tracing

For native Cloudflare handler spans, use
[`CloudflareTracingInterceptor`](../packages/cloudflare/README.md#native-handler-tracing)
from `@velajs/cloudflare/tracing`. It wraps awaited HTTP and service RPC handler
work in the platform's `tracing.enterSpan` callback, leaving sampling and export
to Cloudflare. Its boundary is the handler promise, so it does not include the
full response/deferred/disposal lifetime described above. It does not implement
`Telemetry`, expose trace IDs or bridge explicit propagation to native spans.

## OpenTelemetry

Use an already configured OpenTelemetry tracer and optional meter. This bridge
accepts their structural interfaces and has no package or exporter dependency.
Install the OpenTelemetry API and compatible SDK/exporters in your application
only if you choose them. Use an SDK compatible with your target runtime.

```ts
import { ROOT_CONTEXT, createTraceState, metrics, trace } from '@opentelemetry/api';
import { createOpenTelemetry } from '@velajs/vela/observability';

const telemetry = createOpenTelemetry({
  tracer: trace.getTracer('service'),
  meter: metrics.getMeter('service'),
  rootContext: ROOT_CONTEXT,
  parentContext: (parent) => trace.setSpanContext(ROOT_CONTEXT, {
    traceId: parent.traceId,
    spanId: parent.spanId,
    traceFlags: parent.traceFlags,
    isRemote: parent.isRemote,
    traceState: parent.traceState ? createTraceState(parent.traceState) : undefined,
  }),
});
```

The bridge passes either `rootContext` or the supplied validated parent to
`tracer.startSpan`. It never reads `context.active()` or installs a context manager.
Successful and cancelled spans leave OpenTelemetry status unset; errors set ERROR.
All spans carry the explicit `vela.outcome` on completion. Raw exceptions are not
recorded. See the OpenTelemetry [trace API](https://github.com/open-telemetry/opentelemetry-js/blob/main/api/src/trace/tracer.ts)
and [metrics guide](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/metrics.md).

## Other execution boundaries

`createExecutionTelemetryObserver` supplies structural hooks for optional queue,
scheduled, or durable execution integrations. It does not import or depend on
those integrations. Configure a fixed operation name, never a job identifier:

```ts
const observer = createExecutionTelemetryObserver({
  telemetry,
  operation: 'queue.process',
  kind: 'consumer',
  parent: () => explicitParent,
});

const observation = observer.onStart();
try {
  await performWork();
  observation.onEnd('success');
} catch (error) {
  observation.onEnd(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error');
  throw error;
}
```

Each observation owns its span and records one `vela.execution.count` increment
and `vela.execution.duration` in seconds. Labels contain the configured operation
and outcome only. The integration decides whether the boundary is one attempt or
the whole operation, and must await any owned work before ending it. Built-in
adapters contain recorder errors and end at most once. Custom instrumentation can
use `safeTelemetry` for the same containment and idempotent span completion.
