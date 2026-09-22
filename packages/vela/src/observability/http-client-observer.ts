import { injectTraceContext, validateTraceContext } from './trace-context';
import { safeTelemetry, telemetryHttpMethod } from './telemetry';
import type { Telemetry, TelemetryAttributes, TelemetryOutcome, TraceContext } from './types';

export interface HttpClientTelemetryOptions {
  readonly telemetry?: Telemetry;
  /** Read explicit invocation-local state when each outgoing request starts. */
  readonly parent?: () => TraceContext | undefined;
}

/** Structural HTTP-client hook contract; it has no dependency on a fetch implementation. */
export interface HttpClientTelemetryObserver {
  onRequest(request: { readonly method: string; readonly headers: Headers }): {
    onResponse(response: { readonly status: number }): void;
    onError(error: unknown): void;
    onEnd(): void;
  };
}

/**
 * One client span per observed request. Only W3C trace headers are injected into
 * the caller-owned Headers; URL, query, credentials, and response headers are not recorded.
 */
export function createHttpClientTelemetryObserver(
  options: HttpClientTelemetryOptions = {},
): HttpClientTelemetryObserver {
  const telemetry = safeTelemetry(options.telemetry);
  const requests = telemetry.createCounter('http.client.request.count', { unit: '{request}' });
  const duration = telemetry.createHistogram('http.client.request.duration', { unit: 's' });
  return {
    onRequest(request) {
      const startedAt = performance.now();
      const method = telemetryHttpMethod(request.method);
      let parent: TraceContext | undefined;
      try {
        parent = options.parent?.();
      } catch {
        // Broken context lookup must not prevent sending the request.
      }
      const span = telemetry.startSpan(`HTTP ${method}`, {
        kind: 'client',
        parent,
        attributes: { 'http.request.method': method },
      });
      try {
        const context = validateTraceContext(span.context);
        if (context) injectTraceContext(request.headers, context);
      } catch {
        // A caller may supply immutable Headers; recording remains optional.
      }
      let status: number | undefined;
      let outcome: TelemetryOutcome = 'success';
      let ended = false;
      return {
        onResponse(response) {
          if (ended) return;
          if (
            Number.isInteger(response.status) &&
            response.status >= 100 &&
            response.status <= 599
          ) {
            status = response.status;
            if (status >= 400) outcome = 'error';
          }
        },
        onError(error) {
          if (ended) return;
          outcome = 'error';
          if (error instanceof Error && error.name === 'AbortError') outcome = 'cancelled';
        },
        onEnd() {
          if (ended) return;
          ended = true;
          const attributes: TelemetryAttributes = Object.freeze({
            'http.request.method': method,
            ...(status === undefined ? {} : { 'http.response.status_code': status }),
            'vela.outcome': outcome,
          });
          span.setAttributes(attributes);
          span.end(outcome);
          requests.add(1, attributes);
          duration.record(Math.max(0, performance.now() - startedAt) / 1000, attributes);
        },
      };
    },
  };
}
