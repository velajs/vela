import { safeTelemetry, safely, noopTelemetry } from './telemetry';
import { validateTraceContext } from './trace-context';
import type {
  Telemetry,
  TelemetryAttributes,
  TelemetryCounter,
  TelemetryHistogram,
  TelemetryMetricOptions,
  TelemetrySpanKind,
  TraceContext,
} from './types';

/** The structural subset of an OpenTelemetry span needed by this adapter. */
export interface OpenTelemetrySpan {
  spanContext(): {
    readonly traceId: string;
    readonly spanId: string;
    readonly traceFlags: number;
    readonly traceState?: { serialize(): string };
  };
  setAttributes(attributes: TelemetryAttributes): unknown;
  setStatus(status: { code: 0 | 1 | 2 }): unknown;
  end(): void;
}

/** Supply an already-configured SDK/API; no globals, SDK packages, or exporters are imported. */
export interface OpenTelemetryOptions<Context> {
  readonly tracer: {
    startSpan(
      name: string,
      options: {
        kind: 0 | 1 | 2 | 3 | 4;
        attributes?: TelemetryAttributes;
      },
      context: Context,
    ): OpenTelemetrySpan;
  };
  readonly meter?: {
    createCounter(name: string, options?: TelemetryMetricOptions): TelemetryCounter;
    createHistogram(name: string, options?: TelemetryMetricOptions): TelemetryHistogram;
  };
  /** Pass ROOT_CONTEXT, never an ambient active context. */
  readonly rootContext: Context;
  /** Build a context from this validated parent, usually trace.setSpanContext(ROOT_CONTEXT, ...). */
  readonly parentContext: (parent: TraceContext) => Context;
}

const spanKinds: Record<TelemetrySpanKind, 0 | 1 | 2 | 3 | 4> = {
  internal: 0,
  server: 1,
  client: 2,
  producer: 3,
  consumer: 4,
};

/** Bridge explicit contexts to OpenTelemetry while leaving SDK lifecycle under application ownership. */
export function createOpenTelemetry<Context>(options: OpenTelemetryOptions<Context>): Telemetry {
  return safeTelemetry({
    startSpan(name, spanOptions = {}) {
      const parent = validateTraceContext(spanOptions.parent);
      const context = parent ? options.parentContext(parent) : options.rootContext;
      const span = options.tracer.startSpan(
        name,
        {
          kind: spanKinds[spanOptions.kind ?? 'internal'],
          attributes: spanOptions.attributes,
        },
        context,
      );
      let trace: TraceContext | undefined;
      try {
        const source = span.spanContext();
        trace = validateTraceContext({
          traceId: source.traceId,
          spanId: source.spanId,
          traceFlags: source.traceFlags,
          traceState: source.traceState?.serialize(),
        });
      } catch {
        // Ending a started span must remain possible even if its context is unavailable.
      }
      return {
        context: trace,
        setAttributes: (attributes) => {
          safely(() => span.setAttributes(attributes));
        },
        end(outcome = 'success') {
          safely(() => span.setAttributes({ 'vela.outcome': outcome }));
          // Leave successful spans UNSET so instrumentation does not override SDK policy.
          if (outcome === 'error') safely(() => span.setStatus({ code: 2 }));
          safely(() => span.end());
        },
      };
    },
    createCounter: (name, metricOptions) =>
      options.meter?.createCounter(name, metricOptions) ??
      noopTelemetry.createCounter(name, metricOptions),
    createHistogram: (name, metricOptions) =>
      options.meter?.createHistogram(name, metricOptions) ??
      noopTelemetry.createHistogram(name, metricOptions),
  });
}
