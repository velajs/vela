import { validateTraceContext } from './trace-context';
import type { ScopedTelemetry, Telemetry, TelemetrySpan } from './types';

export const noopSpan: TelemetrySpan = Object.freeze({
  context: undefined,
  setAttributes() {},
  end() {},
});

export const noopTelemetry: Telemetry = Object.freeze({
  startSpan: () => noopSpan,
  createCounter: () => ({ add() {} }),
  createHistogram: () => ({ record() {} }),
});

export const noopScopedTelemetry: ScopedTelemetry = Object.freeze({
  telemetry: noopTelemetry,
  span: noopSpan,
});

/** @internal Contain synchronous throws and accidental async rejections without waiting for delivery. */
export function safely(record: () => unknown): void {
  try {
    const result = record();
    if (result !== undefined) void Promise.resolve(result).catch(() => {});
  } catch {
    // Application behavior cannot depend on diagnostics availability.
  }
}

/** Wrap a custom recorder once at an integration boundary. No recording call can fail the request. */
export function safeTelemetry(telemetry: Telemetry = noopTelemetry): Telemetry {
  if (telemetry === noopTelemetry) return telemetry;
  return {
    startSpan(name, options) {
      let source: TelemetrySpan;
      try {
        source = telemetry.startSpan(
          name,
          options ? { ...options, parent: validateTraceContext(options.parent) } : undefined,
        );
        if (!source || 'then' in source) {
          safely(() => source);
          return noopSpan;
        }
      } catch {
        return noopSpan;
      }
      let ended = false;
      let context;
      try {
        context = validateTraceContext(source.context);
      } catch {
        // A broken recorder may still have an end hook worth calling.
      }
      return Object.freeze({
        context,
        setAttributes(attributes) {
          if (!ended) safely(() => source.setAttributes(attributes));
        },
        end(outcome = 'success') {
          if (ended) return;
          ended = true;
          safely(() => source.end(outcome));
        },
      } satisfies TelemetrySpan);
    },
    createCounter(name, options) {
      try {
        const counter = telemetry.createCounter(name, options);
        if (!counter || 'then' in counter) {
          safely(() => counter);
          return noopTelemetry.createCounter(name, options);
        }
        return { add: (value, attributes) => safely(() => counter.add(value, attributes)) };
      } catch {
        return noopTelemetry.createCounter(name, options);
      }
    },
    createHistogram(name, options) {
      try {
        const histogram = telemetry.createHistogram(name, options);
        if (!histogram || 'then' in histogram) {
          safely(() => histogram);
          return noopTelemetry.createHistogram(name, options);
        }
        return { record: (value, attributes) => safely(() => histogram.record(value, attributes)) };
      } catch {
        return noopTelemetry.createHistogram(name, options);
      }
    },
  };
}

/** Default HTTP labels accept only the standard finite method set. */
export function telemetryHttpMethod(method: string): string {
  return ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'].includes(
    method,
  )
    ? method
    : '_OTHER';
}
