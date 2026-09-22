import { safeTelemetry } from './telemetry';
import type { Telemetry, TelemetryOutcome, TelemetrySpanKind, TraceContext } from './types';

export interface ExecutionTelemetryOptions {
  readonly telemetry?: Telemetry;
  /** A fixed operation name, configured by the application; never a job or tenant identifier. */
  readonly operation: string;
  readonly kind?: TelemetrySpanKind;
  readonly parent?: () => TraceContext | undefined;
}

export interface ExecutionTelemetryObserver {
  onStart(): { onEnd(outcome: TelemetryOutcome): void };
}

/** Explicit begin/end hooks for queues, durable execution, and other non-HTTP integrations. */
export function createExecutionTelemetryObserver(
  options: ExecutionTelemetryOptions,
): ExecutionTelemetryObserver {
  if (
    typeof options.operation !== 'string' ||
    !options.operation ||
    options.operation.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(options.operation)
  ) {
    throw new TypeError('Telemetry operation must be a fixed name between 1 and 128 characters.');
  }
  const operation = options.operation;
  const telemetry = safeTelemetry(options.telemetry);
  const count = telemetry.createCounter('vela.execution.count', { unit: '{execution}' });
  const duration = telemetry.createHistogram('vela.execution.duration', { unit: 's' });
  return {
    onStart() {
      const startedAt = performance.now();
      let parent: TraceContext | undefined;
      try {
        parent = options.parent?.();
      } catch {
        // Context lookup cannot prevent execution.
      }
      const span = telemetry.startSpan(operation, {
        kind: options.kind ?? 'internal',
        parent,
        attributes: { 'vela.operation': operation },
      });
      let ended = false;
      return {
        onEnd(outcome) {
          if (ended) return;
          ended = true;
          const attributes = Object.freeze({
            'vela.operation': operation,
            'vela.outcome': outcome,
          });
          span.setAttributes(attributes);
          span.end(outcome);
          count.add(1, attributes);
          duration.record(Math.max(0, performance.now() - startedAt) / 1000, attributes);
        },
      };
    },
  };
}
